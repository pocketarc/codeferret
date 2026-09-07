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
 * Whether those rules still name fields merged-schema.json has is a question about this
 * repository rather than about a review, so `checkFindingRules` in
 * scripts/checks/finding-rules.ts asks it by calling `selfCheck` directly. This command reads
 * findings and nothing else.
 *
 * Usage: bun check-findings.ts <findings.json>
 *
 * Exit: 0 nothing wrong, 3 something was dropped and what is left is worth posting,
 *       1 the file cannot be read as a run's output at all, 2 nothing was given to check.
 */

import { dirname, join } from "node:path";
import { applyRules, readSchema, selfCheck } from "./finding-rules.ts";
import { reason, record } from "./json.ts";
import { readDispatched, RUN_FILES } from "./run-files.ts";

const [path] = process.argv.slice(2);

if (!path) {
    console.error("usage: bun check-findings.ts <findings.json>");
    process.exit(2);
}

const schema = await readSchema();
const rules = selfCheck(schema);

// Loud, and then on with the review: a rule that stopped running is not evidence against
// the findings in front of it, and failing here would leave the drift for the next run
// anyway.
if (rules.stray.length > 0) {
    // An absolute path, because whoever pastes this line is standing wherever the run left
    // them, which during a review is the checkout under review rather than this repository.
    const validate = join(import.meta.dir, "..", "scripts", "validate-repo.ts");

    console.warn(`WARN check-findings.ts keys ${rules.stray.join(", ")}, which merged-schema.json has no field for.`);
    console.warn(`Run \`bun --config=/dev/null ${validate} finding-rules\` and fix the table.`);
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

// The lenses this run dispatched, read out of the run directory because it is already there
// and a second argument is a second thing to keep in step. `readDispatched` has what an empty
// answer means.
const checked = applyRules(schema, merged, await readDispatched(runDir));

for (const r of checked.repairs) console.warn(`FIXED ${r}`);
for (const c of checked.coverage) console.warn(`WARN ${c}`);
for (const w of checked.warnings) console.warn(`WARN ${w.label}: ${w.message}`);
for (const p of checked.elsewhere) console.warn(`WARN ${p.label}: ${p.message}`);
for (const p of checked.dropped) console.error(`DROP ${p.label}: ${p.message}`);

const lost = checked.found - checked.kept;

if (lost > 0 || checked.droppedEntries > 0) {
    const warning =
        `Warning: The validator removed ${lost} ${lost === 1 ? "finding" : "findings"} and ` +
        `${checked.droppedEntries} other ${checked.droppedEntries === 1 ? "entry" : "entries"}. The posted review may be incomplete.`;
    const notes = typeof checked.merged.notes === "string" ? checked.merged.notes : "";
    checked.merged.notes = notes === "" ? warning : `${notes}\n\n${warning}`;
}

if (checked.changed) {
    await Bun.write(path, `${JSON.stringify(checked.merged, null, 2)}\n`);

    // extract-findings.ts wrote this count before anything was dropped, and it is the
    // action's `findings-count` output and the Findings row in the job summary. Left alone,
    // it is the number that hides the breakage in a partly-broken run. Rewritten only where
    // the run left one, so a by-hand check of a copied file writes no run files beside it.
    const count = Bun.file(join(runDir, RUN_FILES.findingsCount));

    if (await count.exists()) await Bun.write(count, String(checked.kept));
}

// A file with every finding gone is still worth posting, and 3 rather than 1 is what makes
// the difference: run.sh writes the marker for 3 and the run still ends red. A run whose
// findings were all unusable is the same shape as one whose lenses all died, and
// `Composed.warned` has why that must reach the pull request: the `lens_health` block, the
// coverage notices and every standing caveat are in the file and are the only account a
// reader gets. Exiting 1 here left a reader with a red job and a pull request reading as
// clean. The check above still exits 1 on a file that cannot be read as a run's output at
// all, because there is nothing in one to declare.
if (checked.found > 0 && checked.kept === 0) {
    console.error(
        `\nnothing usable in ${path}: all ${checked.found} finding(s) were dropped.` +
            " Posting what the run said about its own coverage.",
    );
    process.exit(3);
}

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
