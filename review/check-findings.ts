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
 * The shape itself is read out of merged-schema.json rather than mirrored here, so the
 * contract has one home. Everything the schema cannot state is in `POLICY`, one entry per
 * field, and `--self-check` answers whether each of those entries still names a field the
 * schema has.
 *
 * Three outcomes, in order of preference. A fault with one right answer is repaired and
 * written back. A fault post-review.ts survives is noted and the finding kept. Only a
 * finding with nothing left to render is dropped, and the rest of the file is written back
 * around it: failing the whole file would throw away a review that took twenty minutes and
 * tens of dollars to produce. `POLICY` below has why the middle one is the wide case.
 *
 * Usage: bun check-findings.ts <findings.json>
 *        bun check-findings.ts --self-check
 *
 * `--self-check` reads no findings. It answers whether the rules below still name fields
 * merged-schema.json has, which is a question about this repository rather than about a
 * review, so it runs from scripts/validate-manifests.ts, which lefthook and lint.yml
 * both run.
 *
 * Exit: 0 nothing wrong, 3 something was dropped and the rest is worth posting,
 *       1 nothing usable is left, 2 nothing was given to check.
 */

import { join } from "node:path";
import { reason, record } from "./json.ts";

interface JsonSchema {
    type?: string;
    required?: string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    enum?: string[];
    additionalProperties?: boolean;
}

interface Problem {
    path: string;
    message: string;
}

const args = process.argv.slice(2);
const selfCheck = args.includes("--self-check");
const [path] = args.filter((arg) => arg !== "--self-check");

if (!path && !selfCheck) {
    console.error("usage: bun check-findings.ts <findings.json>");
    console.error("       bun check-findings.ts --self-check");
    process.exit(2);
}

const schema = JSON.parse(await Bun.file(join(import.meta.dir, "merged-schema.json")).text()) as JsonSchema;

const statuses = new Set(schema.properties?.findings?.items?.properties?.status?.enum ?? []);
const severities = new Set(schema.properties?.findings?.items?.properties?.severity?.enum ?? []);

/** What a lens_health entry that does not name its lens is called in the review. */
const UNNAMED_LENS = "(unnamed lens)";

/** What a repair did, written after the field's own path in the FIXED line. */
interface Repaired {
    /** The value to write back. Omitted when the field comes off the object entirely. */
    set?: unknown;
    note: string;
}

interface Policy {
    /** A rule about this field that JSON Schema cannot state. */
    check?: (value: unknown) => string | null;
    /**
     * The one right answer for a fault here, applied before anything reads the value. It
     * sees `undefined` for a field that is not there, because a missing count renders as
     * the word "undefined" just as a string one does.
     */
    repair?: (value: unknown) => Repaired | null;
    /** Whether post-review.ts survives a fault here, so the finding is kept and noted. */
    tolerated?: true;
    /** Whether post-review.ts can render this entry at all. One that fails is dropped. */
    renderable?: (entry: Record<string, unknown>) => boolean;
}

/**
 * Everything this script does to a field, one entry per field, keyed by the path the walk
 * builds with an array index written as `[]`.
 *
 * One table rather than one per facet, so that the answer to "what happens to
 * `findings[].severity`" is in one place, and so that `--self-check` covers every rule at
 * once.
 *
 * `tolerated` is the wide case. A dropped finding is in neither the comment, nor the
 * findings file, nor the next run's `previous.json`, so nothing records that it existed.
 * Only the three fields that leave nothing to render are fatal: `file`, `title` and `body`.
 * `found_by` and `in_diff` are never read; a finding with no usable `line` is listed under
 * its file alone; a `severity` nothing recognises is listed in full rather than left out;
 * and a missing `category` is a cosmetic `_undefined_`. A key this table does not name is
 * ignored by everything downstream, which reads the fields it needs by name.
 */
const POLICY: Record<string, Policy> = {
    summary: { repair: proseOrNothing },
    notes: { repair: proseOrNothing },
    "findings[].found_by": { tolerated: true },
    "findings[].in_diff": { tolerated: true },
    "findings[].line": { check: positive, tolerated: true },
    "findings[].end_line": { check: positive, tolerated: true },
    "findings[].file": { repair: repoRelative },
    "findings[].status": { repair: knownStatus, tolerated: true },
    "findings[].severity": { repair: knownSeverity, tolerated: true },
    "findings[].category": { tolerated: true },
    "resolve[]": { renderable: (entry) => typeof entry.thread_id === "string" && typeof entry.reason === "string" },
    // Every entry that is an object at all is kept. It carries `detail`, which is the one
    // place a lens's account of what it could not check is written down, and the body
    // derives "N lenses ran" from what survives here, so a dropped entry shrinks that count
    // and leaves a review of an interface change looking as though accessibility had been
    // covered. The fields below are repaired instead.
    "lens_health[]": { renderable: () => true },
    "lens_health[].lens": { repair: lensName },
    "lens_health[].findings_returned": { repair: count },
    "lens_health[].detail": { repair: optionalProse },
};

const UNKNOWN_KEY = /^has an unknown key /;

function positive(value: unknown): string | null {
    return typeof value === "number" && value < 1 ? `must be 1 or more, got ${value}` : null;
}

/**
 * A prose field the body renders whole.
 *
 * Each reaches a string method in review-body.ts, so a number here is a TypeError twenty
 * minutes and tens of dollars into a run, at the one point where nothing is left to repair
 * it. Removed rather than coerced: what a model wrote that is not a string is not the
 * summary either.
 */
function proseOrNothing(value: unknown): Repaired | null {
    if (value === undefined || typeof value === "string") return null;

    return { note: `${JSON.stringify(value)} is not prose, so it was removed` };
}

/** `detail` is optional, so one that is not prose costs the field and not the lens's line. */
function optionalProse(value: unknown): Repaired | null {
    return proseOrNothing(value);
}

/**
 * Matching against the previous run is on the file and the title, so `/src/a.ts` and
 * `src/a.ts` are two files to everything downstream and the finding is raised twice.
 */
function repoRelative(value: unknown): Repaired | null {
    if (typeof value !== "string" || !value.startsWith("/")) return null;

    return {
        set: value.replace(/^\/+/, ""),
        note: `'${value}' is not repo-relative, so the leading slash was removed`,
    };
}

function knownStatus(value: unknown): Repaired | null {
    if (statuses.size === 0) return null;
    if (typeof value === "string" && statuses.has(value)) return null;

    return { set: "new", note: `${JSON.stringify(value)} is not a status, so it was set to 'new'` };
}

/**
 * Where a finding sorts, and whether the posted body prints it in full, both come from its
 * severity. `LISTED` is an exact-match lookup, so `Critical` or ` high ` misses it and a
 * critical finding drops out of the comment. A case or whitespace variant has one right
 * answer; a word nothing recognises does not, and review-body.ts lists that one rather than
 * leaving it out.
 */
function knownSeverity(value: unknown): Repaired | null {
    if (typeof value !== "string" || severities.size === 0 || severities.has(value)) return null;

    const normalised = value.trim().toLowerCase();

    if (!severities.has(normalised)) return null;

    return { set: normalised, note: `'${value}' is a spelling of '${normalised}'` };
}

function lensName(value: unknown): Repaired | null {
    if (typeof value === "string" && value.trim() !== "") return null;

    return { set: UNNAMED_LENS, note: `${JSON.stringify(value)} is not a name, so it reads '${UNNAMED_LENS}'` };
}

/**
 * `plural` puts this straight into the review, so a missing one prints the word "undefined"
 * where a reader expects a count. The findings array is the record of what the lens actually
 * returned; this field is only its own account of it.
 */
function count(value: unknown): Repaired | null {
    if (Number.isInteger(value)) return null;

    return { set: 0, note: `${JSON.stringify(value)} is not a count, so it reads 0` };
}

/** The path with every array index replaced by `[]`, which is how `POLICY` is keyed. */
function shape(path: string): string {
    return path.replace(/\[\d+\]/g, "[]");
}

function tolerated(problem: Problem): boolean {
    if (POLICY[shape(problem.path)]?.tolerated) return true;

    // An unknown key is reported against the finding rather than against a field, so it
    // cannot be keyed above without tolerating "must be an object" with it. post-review.ts
    // reads the fields it needs by name, so a `confidence` a model invented costs nothing.
    return shape(problem.path) === "findings[]" && UNKNOWN_KEY.test(problem.message);
}

function schemaPaths(node: JsonSchema, path: string, out: Set<string>): void {
    out.add(path);

    if (node.type === "object") {
        for (const [key, child] of Object.entries(node.properties ?? {})) {
            schemaPaths(child, path ? `${path}.${key}` : key, out);
        }

        return;
    }

    if (node.type === "array" && node.items) schemaPaths(node.items, `${path}[]`, out);
}

/**
 * Apply the repair `POLICY` names for one field of one object, and say what it did.
 *
 * Run from inside the walk, before anything reads the value, so what the walk goes on to
 * report is what will be written back. Ordering the two by hand is what let a repaired
 * field be reported as broken once.
 */
function repairField(host: Record<string, unknown>, key: string, path: string, notes: string[]): void {
    const done = POLICY[shape(path)]?.repair?.(host[key]);

    if (!done) return;

    if ("set" in done) host[key] = done.set;
    else delete host[key];

    notes.push(`${path}: ${done.note}`);
}

function walk(value: unknown, node: JsonSchema, path: string, out: Problem[], notes: string[]): void {
    const problem = (message: string): void => {
        out.push({ path, message });
    };

    // First, because the three branches below each return, and a rule on an object or an
    // array would otherwise read as configured and never fire.
    const complaint = POLICY[shape(path)]?.check?.(value);
    if (complaint) problem(complaint);

    if (node.enum && (typeof value !== "string" || !node.enum.includes(value))) {
        problem(`must be one of ${node.enum.join(", ")}, got ${JSON.stringify(value)}`);
        return;
    }

    if (node.type === "object") {
        const object = record(value);

        if (!object) {
            problem(`must be an object, got ${JSON.stringify(value)}`);
            return;
        }

        // Every property, present or not: a `findings_returned` that is missing renders as
        // the word "undefined" exactly as a string one does.
        for (const key of Object.keys(node.properties ?? {})) {
            repairField(object, key, path ? `${path}.${key}` : key, notes);
        }

        // Reported against the missing field's own path, so that `POLICY` can name it the
        // way it names a field that is present and wrong.
        for (const key of node.required ?? []) {
            if (object[key] === undefined) {
                out.push({ path: path ? `${path}.${key}` : key, message: "is missing" });
            }
        }

        if (node.additionalProperties === false) {
            for (const key of Object.keys(object)) {
                if (!node.properties?.[key]) problem(`has an unknown key \`${key}\``);
            }
        }

        for (const [key, child] of Object.entries(node.properties ?? {})) {
            if (object[key] !== undefined) walk(object[key], child, path ? `${path}.${key}` : key, out, notes);
        }

        return;
    }

    if (node.type === "array") {
        if (!Array.isArray(value)) {
            problem(`must be an array, got ${JSON.stringify(value)}`);
            return;
        }

        if (node.items) {
            const items = node.items;
            value.forEach((item, i) => walk(item, items, `${path}[${i}]`, out, notes));
        }

        return;
    }

    if (node.type === "string") {
        if (typeof value !== "string") problem(`must be a string, got ${JSON.stringify(value)}`);
        else if (value.trim() === "") problem("is empty");
    }

    if (node.type === "integer" && !Number.isInteger(value)) {
        problem(`must be an integer, got ${JSON.stringify(value)}`);
    }

    if (node.type === "boolean" && typeof value !== "boolean") {
        problem(`must be a boolean, got ${JSON.stringify(value)}`);
    }
}

// A key in POLICY that the schema has no field for is a rule that stopped running, and a
// findings file that rule would have caught is still reported `shape valid`. A rename in the
// schema, or a typo here, is a problem with this repository rather than with a review, and
// it is answerable without running anything, so `--self-check` is what fails on it.
const known = new Set<string>();
schemaPaths(schema, "", known);

const rules = Object.keys(POLICY);
const stray = rules.filter((key) => !known.has(key));

// The two enums are read out of the schema by name, and a rename empties them without
// emptying POLICY, so the key check above cannot catch it. An empty set means the status
// normalisation and the severity spelling repair are both silently off, and an unnormalised
// `Critical` then misses `LISTED` and drops a critical finding out of the posted body.
const enumsLost = [
    ...(statuses.size === 0 ? ["status"] : []),
    ...(severities.size === 0 ? ["severity"] : []),
];

if (selfCheck) {
    if (stray.length > 0) {
        console.error(`FAIL check-findings.ts keys ${stray.join(", ")}, which merged-schema.json has no field for.`);
        process.exit(1);
    }

    if (enumsLost.length > 0) {
        console.error(
            `FAIL merged-schema.json carries no ${enumsLost.join(" or ")} enum,` +
                " so the repair that normalises it is not running.",
        );
        process.exit(1);
    }

    console.log(`OK check-findings.ts: ${rules.length} rule(s) name a field merged-schema.json has`);
    process.exit(0);
}

if (!path) {
    console.error("usage: bun check-findings.ts <findings.json>");
    process.exit(2);
}

// Loud, and then on with the review. This runs after a review that took twenty minutes and
// tens of dollars, and a rule that stopped running is not evidence against the findings in
// front of it. Failing here would cost the review and leave the drift for the next run
// anyway.
if (stray.length > 0) {
    console.warn(`WARN check-findings.ts keys ${stray.join(", ")}, which merged-schema.json has no field for.`);
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

const found = merged.findings.length;

const repairs: string[] = [];

// `posted` belongs to post-review.ts, which writes it once GitHub has accepted the review.
// It is the only evidence fetch-previous.ts has that a run's findings were said out loud,
// and this runs before anything is posted, so whatever put one here invented it.
if (merged.posted !== undefined) {
    delete merged.posted;
    repairs.push("posted: removed. Only a review GitHub has accepted may record one");
}

/**
 * The fields an entry has to carry for post-review.ts to render it at all.
 *
 * Whole entries, which `POLICY`'s per-field repairs cannot answer for: an entry that is not
 * an object has no field to repair. Dropped before the walk, so what the walk reports on is
 * what gets written back.
 *
 * A container that is not a list at all is removed rather than filtered. `post-review.ts`
 * reads `merged.resolve ?? []` and `merged.lens_health ?? []`, which catches a missing key
 * and not a `{}`, so leaving one in place is a TypeError after the review has been paid for.
 */
const keepEntries = (key: "resolve" | "lens_health"): number => {
    const list = merged[key];

    if (list === undefined) return 0;

    if (!Array.isArray(list)) {
        delete merged[key];
        repairs.push(`${key}: ${JSON.stringify(list)} is not a list, so it was removed`);
        return 0;
    }

    const renderable = POLICY[`${key}[]`]?.renderable ?? (() => true);

    const kept = list.filter((entry) => {
        const object = record(entry);
        return object !== null && renderable(object);
    });

    const dropped = list.length - kept.length;
    if (dropped > 0) merged[key] = kept;

    return dropped;
};

const droppedEntries = keepEntries("resolve") + keepEntries("lens_health");

const problems: Problem[] = [];

// The repairs happen inside this walk, so nothing has to keep two passes in the right
// order, and every rule the file applies is keyed the same way.
walk(merged, schema, "", problems, repairs);

const label = (problem: Problem): string => {
    const owner = problem.path.match(/^findings\[(\d+)\]/)?.[1];
    if (owner === undefined) return problem.path || "findings.json";

    const raw = merged.findings;
    const title = Array.isArray(raw) ? record(raw[Number(owner)])?.title : undefined;

    return typeof title === "string" ? `${problem.path} (${title})` : problem.path;
};

const fatal = problems.filter((p) => !tolerated(p));
const warnings = problems.filter(tolerated);

// Everything under one finding, so that a finding with three faults is dropped once.
const doomed = new Set<number>();

for (const p of fatal) {
    const owner = p.path.match(/^findings\[(\d+)\]/)?.[1];
    if (owner !== undefined) doomed.add(Number(owner));
}

// A fault outside `findings` costs a line of the review rather than a finding: post-review.ts
// logs a GraphQL error and carries on for a thread id GitHub does not know, and a
// findings_returned that is not a number renders as the word it is. What it does not
// survive is a field it calls a string method on, which is why the entries below are
// checked rather than warned about.
const elsewhere = fatal.filter((p) => !/^findings\[/.test(p.path));

for (const r of repairs) console.warn(`FIXED ${r}`);
for (const w of warnings) console.warn(`WARN ${label(w)}: ${w.message}`);
for (const p of elsewhere) console.warn(`WARN ${label(p)}: ${p.message}`);
for (const p of fatal.filter((x) => /^findings\[/.test(x.path))) {
    console.error(`DROP ${label(p)}: ${p.message}`);
}

if (doomed.size > 0 || droppedEntries > 0 || repairs.length > 0) {
    merged.findings = merged.findings.filter((_, i) => !doomed.has(i));
    await Bun.write(path, `${JSON.stringify(merged, null, 2)}\n`);
}

const kept = Array.isArray(merged.findings) ? merged.findings.length : 0;

if (found > 0 && kept === 0) {
    console.error(`\nnothing usable in ${path}: all ${found} finding(s) were dropped.`);
    process.exit(1);
}

if (doomed.size > 0 || droppedEntries > 0) {
    console.error(
        `\n${path}: dropped ${doomed.size} finding(s) and ${droppedEntries} other entr(ies).` +
            ` ${kept} finding(s) left, which is worth posting.`,
    );
    process.exit(3);
}

const noted = warnings.length + elsewhere.length + repairs.length;
console.log(`OK ${path}: ${kept} finding(s), shape valid${noted > 0 ? `, ${noted} worth a look` : ""}`);
