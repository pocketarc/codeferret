#!/usr/bin/env bun
/**
 * Check merged findings against the shape post-review.ts reads, and drop what it cannot use.
 *
 * The action and `/codeferret:review` both run the orchestrator under `--json-schema`,
 * but that is a request to the model rather than a check on what comes back, and
 * post-review.ts validates nothing it is handed. So this is the only thing standing
 * between the orchestrator's output and a posted review: a finding with no `title` is a
 * bullet with no claim on it, and one with no `body` says nothing at all.
 *
 * The rules themselves are in `finding-rules.ts`. What is here is the command: argv, the
 * printing, the write-back and the exit code.
 *
 * Usage: bun check-findings.ts <findings.json>
 *        bun check-findings.ts --self-check
 *
 * `--self-check` reads no findings. It answers whether the rules still name fields
 * merged-schema.json has, which is a question about this repository rather than about a
 * review, so it runs from scripts/validate-repo.ts, which lefthook and lint.yml both run.
 *
 * Exit: 0 nothing wrong, 3 something was dropped and the rest is worth posting,
 *       1 nothing usable is left, 2 nothing was given to check.
 */

import { dirname, join } from "node:path";
import { applyRules, readSchema, selfCheck } from "./finding-rules.ts";
import { reason, record } from "./json.ts";
import { dispatchedFrom, LENS_LIST_FILE, RUN_FILES } from "./run-files.ts";

const args = process.argv.slice(2);
const wantsSelfCheck = args.includes("--self-check");
const [path] = args.filter((arg) => arg !== "--self-check");

if (!path && !wantsSelfCheck) {
    console.error("usage: bun check-findings.ts <findings.json>");
    console.error("       bun check-findings.ts --self-check");
    process.exit(2);
}

const schema = await readSchema();
const rules = selfCheck(schema);

if (wantsSelfCheck) {
    if (rules.stray.length > 0) {
        console.error(
            `FAIL check-findings.ts keys ${rules.stray.join(", ")}, which merged-schema.json has no field for.`,
        );
        process.exit(1);
    }

    if (rules.unruled.length > 0) {
        console.error(
            `FAIL check-findings.ts names no rule for ${rules.unruled.join(", ")}, so a fault there` +
                " drops the whole finding. Add a POLICY entry, or list it in FATAL_FIELDS.",
        );
        process.exit(1);
    }

    if (rules.enumsLost.length > 0) {
        console.error(
            `FAIL merged-schema.json carries no ${rules.enumsLost.join(" or ")} enum,` +
                " so the repair that normalises it is not running.",
        );
        process.exit(1);
    }

    console.log(`OK check-findings.ts: ${rules.rules} rule(s) name a field merged-schema.json has`);
    process.exit(0);
}

if (!path) {
    console.error("usage: bun check-findings.ts <findings.json>");
    process.exit(2);
}

// Loud, and then on with the review: a rule that stopped running is not evidence against
// the findings in front of it, and failing here would leave the drift for the next run
// anyway.
if (rules.stray.length > 0) {
    console.warn(`WARN check-findings.ts keys ${rules.stray.join(", ")}, which merged-schema.json has no field for.`);
    console.warn("Run `bun review/check-findings.ts --self-check` and fix the table.");
}

let parsed: unknown;

try {
    parsed = JSON.parse(await Bun.file(path).text());
} catch (error) {
    console.error(`${path}: ${reason(error)}`);
    process.exit(1);
}

// `null` and `[]` both survive the parse above. Without this guard, `null` ends the run
// in a stack trace and `[]` ends it complaining that `findings` is missing, which sends
// the reader hunting for a field when the whole file is the wrong shape.
const merged = record(parsed);

if (!merged) {
    console.error(`${path}: is ${Array.isArray(parsed) ? "an array" : String(parsed)}, not an object`);
    process.exit(1);
}

if (!Array.isArray(merged.findings)) {
    console.error("findings.json: `findings` is missing or not an array");
    process.exit(1);
}

const runDir = dirname(path);

/**
 * The lenses this run dispatched, from the list build-prompts.sh wrote beside the findings.
 *
 * Read out of the run directory, because it is already there and a second argument is a
 * second thing to keep in step. Absent for a by-hand check of an old file.
 */
async function dispatched(): Promise<string[]> {
    const file = Bun.file(join(runDir, LENS_LIST_FILE));

    if (!(await file.exists())) return [];

    return dispatchedFrom(await file.text());
}

const checked = applyRules(schema, merged, await dispatched());

for (const r of checked.repairs) console.warn(`FIXED ${r}`);
for (const c of checked.coverage) console.warn(`WARN ${c}`);
for (const w of checked.warnings) console.warn(`WARN ${w.label}: ${w.message}`);
for (const p of checked.elsewhere) console.warn(`WARN ${p.label}: ${p.message}`);
for (const p of checked.dropped) console.error(`DROP ${p.label}: ${p.message}`);

if (checked.changed) {
    await Bun.write(path, `${JSON.stringify(checked.merged, null, 2)}\n`);

    // extract-findings.ts wrote this count before anything was dropped, and it is the
    // action's `findings-count` output and the Findings row in the job summary. Left alone,
    // it is the number that hides the breakage in a partly-broken run. Rewritten only where
    // the run left one, so a by-hand check of a copied file writes no run files beside it.
    const count = Bun.file(join(runDir, RUN_FILES.findingsCount));

    if (await count.exists()) await Bun.write(count, String(checked.kept));
}

if (checked.found > 0 && checked.kept === 0) {
    console.error(`\nnothing usable in ${path}: all ${checked.found} finding(s) were dropped.`);
    process.exit(1);
}

const lost = checked.found - checked.kept;

if (lost > 0 || checked.droppedEntries > 0) {
    console.error(
        `\n${path}: dropped ${lost} finding(s) and ${checked.droppedEntries} other entr(ies).` +
            ` ${checked.kept} finding(s) left, which is worth posting.`,
    );
    process.exit(3);
}

const noted =
    checked.warnings.length + checked.elsewhere.length + checked.repairs.length + checked.coverage.length;

console.log(`OK ${path}: ${checked.kept} finding(s), shape valid${noted > 0 ? `, ${noted} worth a look` : ""}`);
