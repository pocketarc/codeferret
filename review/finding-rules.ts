/**
 * What may be wrong with a merged findings file, and what to do about each thing.
 *
 * The rules, the schema walk and the repairs, as functions over a parsed value.
 * `check-findings.ts` is the command around this: it reads argv, prints, writes the file
 * back and maps the outcome to an exit code. The split is the one `post-review.ts` and
 * `review-body.ts` have, and it is what lets a rule be tested without spawning a process and
 * reading its log.
 *
 * The shape itself is read out of merged-schema.json, so the contract has one home.
 * Everything the schema cannot state is in `POLICY`, one entry per field, and `selfCheck`
 * answers whether each of those entries still names a field the schema has.
 *
 * Three outcomes, in order of preference. A fault with one right answer is repaired. A fault
 * post-review.ts survives is noted and the finding kept. Only a finding with nothing left to
 * render is dropped, and the rest of the file survives around it: failing the whole file
 * would throw away a review that took twenty minutes and tens of dollars to produce.
 * `POLICY` below has why the middle one is the wide case.
 */

import { join } from "node:path";
import { record } from "./json.ts";
import { lensLabel } from "./review-body.ts";

export interface JsonSchema {
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

/** A problem with the finding it belongs to named, ready to print. */
export interface Reported {
    label: string;
    message: string;
}

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
    repair?: (value: unknown, enums: Enums) => Repaired | null;
    /** Whether post-review.ts survives a fault here, so the finding is kept and noted. */
    tolerated?: true;
    /** Whether post-review.ts can render this entry at all. One that fails is dropped. */
    renderable?: (entry: Record<string, unknown>) => boolean;
}

/** The two enums the repairs below normalise against, read out of the schema by name. */
interface Enums {
    statuses: ReadonlySet<string>;
    severities: ReadonlySet<string>;
}

/**
 * Everything applied to a field, one entry per field, keyed by the path the walk builds with
 * an array index written as `[]`.
 *
 * One table covering every facet, so that the answer to "what happens to
 * `findings[].severity`" is in one place, and so that `selfCheck` covers every rule at once.
 *
 * `tolerated` is the wide case. A dropped finding is in neither the comment, nor the
 * findings file, nor the next run's `previous.json`, so nothing records that it existed.
 * Only the fields that leave nothing to render are fatal: `file`, `title` and `body`.
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
    "lens_health[].ok": { repair: reporting },
    // Optional, so one that is not prose is dropped and the lens keeps its line.
    "lens_health[].detail": { repair: proseOrNothing },
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

/**
 * Matching against the previous run is on the file, so `/src/a.ts` and `src/a.ts` are two
 * files to everything downstream and the finding is raised twice.
 */
function repoRelative(value: unknown): Repaired | null {
    if (typeof value !== "string" || !value.startsWith("/")) return null;

    return {
        set: value.replace(/^\/+/, ""),
        note: `'${value}' is not repo-relative, so the leading slash was removed`,
    };
}

function knownStatus(value: unknown, enums: Enums): Repaired | null {
    if (enums.statuses.size === 0) return null;
    if (typeof value === "string" && enums.statuses.has(value)) return null;

    return { set: "new", note: `${JSON.stringify(value)} is not a status, so it was set to 'new'` };
}

/**
 * Where a finding sorts, and whether the posted body prints it in full, both come from its
 * severity. `LISTED` is an exact-match lookup, so `Critical` or ` high ` misses it and a
 * critical finding drops out of the comment. A case or whitespace variant has one right
 * answer; a word nothing recognises does not, and review-body.ts lists that one anyway.
 */
function knownSeverity(value: unknown, enums: Enums): Repaired | null {
    if (typeof value !== "string" || enums.severities.size === 0 || enums.severities.has(value)) return null;

    const normalised = value.trim().toLowerCase();

    if (!enums.severities.has(normalised)) return null;

    return { set: normalised, note: `'${value}' is a spelling of '${normalised}'` };
}

function lensName(value: unknown): Repaired | null {
    if (typeof value === "string" && value.trim() !== "") return null;

    return { set: UNNAMED_LENS, note: `${JSON.stringify(value)} is not a name, so it reads '${UNNAMED_LENS}'` };
}

/**
 * The count beside a lens's name in the review. The findings array is the record of what
 * that lens returned; this field is only its own account of it.
 */
function count(value: unknown): Repaired | null {
    if (Number.isInteger(value)) return null;

    return { set: 0, note: `${JSON.stringify(value)} is not a count, so it reads 0` };
}

/**
 * Whether a lens reported normally, repaired towards the answer that is safe to be wrong
 * about.
 *
 * `brokenLenses` is `!h.ok` and the body renders `h.ok ? "" : ", **needs attention**"`, so
 * the string `"false"` is truthy and a dead lens reads as healthy: the warning alert, the
 * heading count and the open disclosure all go, and post-review.ts takes a run with no new
 * findings as one worth posting nothing for. Anything that is not a boolean is a lens whose
 * account of itself did not arrive, which is what `false` says.
 */
function reporting(value: unknown): Repaired | null {
    if (typeof value === "boolean") return null;

    return { set: false, note: `${JSON.stringify(value)} is not a boolean, so the lens reads as needing attention` };
}

/** The path with every array index replaced by `[]`, which is how `POLICY` is keyed. */
function shape(path: string): string {
    return path.replace(/\[\d+\]/g, "[]");
}

function tolerated(problem: Problem): boolean {
    if (POLICY[shape(problem.path)]?.tolerated) return true;

    // An unknown key is reported against the finding rather than against a field, so it
    // cannot be keyed above without tolerating "must be an object" with it. post-review.ts
    // reads the fields it needs by name, so a `confidence` a model invented is ignored.
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
 * report is what will be written back.
 */
function repairField(
    host: Record<string, unknown>,
    key: string,
    path: string,
    notes: string[],
    enums: Enums,
): void {
    const done = POLICY[shape(path)]?.repair?.(host[key], enums);

    if (!done) return;

    if ("set" in done) host[key] = done.set;
    else delete host[key];

    notes.push(`${path}: ${done.note}`);
}

function walk(
    value: unknown,
    node: JsonSchema,
    path: string,
    out: Problem[],
    notes: string[],
    enums: Enums,
): void {
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

        // Every property, present or not, for the reason `Policy.repair` gives.
        for (const key of Object.keys(node.properties ?? {})) {
            repairField(object, key, path ? `${path}.${key}` : key, notes, enums);
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
            if (object[key] !== undefined) walk(object[key], child, path ? `${path}.${key}` : key, out, notes, enums);
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
            value.forEach((item, i) => walk(item, items, `${path}[${i}]`, out, notes, enums));
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

/** The contract itself, beside the rules that read it. */
export async function readSchema(): Promise<JsonSchema> {
    return JSON.parse(await Bun.file(join(import.meta.dir, "merged-schema.json")).text()) as JsonSchema;
}

function enumsOf(schema: JsonSchema): Enums {
    const items = schema.properties?.findings?.items?.properties;

    return {
        statuses: new Set(items?.status?.enum ?? []),
        severities: new Set(items?.severity?.enum ?? []),
    };
}

export interface SelfCheck {
    /** How many rules `POLICY` holds, for the line a clean self-check prints. */
    rules: number;
    /** Rule keys naming a field the schema has not got, which are rules that stopped running. */
    stray: string[];
    /** Enums read out of the schema by name that came back empty, so their repair is off. */
    enumsLost: string[];
}

/**
 * Whether the rules still name fields the schema has.
 *
 * A key in `POLICY` the schema has no field for is a rule that stopped running, and a
 * findings file that rule would have caught is still reported `shape valid`. A rename in the
 * schema, or a typo in the table, is a problem with this repository and is answerable
 * without running a review, which is why `--self-check` is what fails on it.
 *
 * The two enums are read out of the schema by name, and a rename empties them without
 * emptying `POLICY`, so the key check alone cannot catch it. An empty set means the status
 * normalisation and the severity spelling repair are both silently off, and an unnormalised
 * `Critical` then misses `LISTED` and drops a critical finding out of the posted body.
 */
export function selfCheck(schema: JsonSchema): SelfCheck {
    const known = new Set<string>();
    schemaPaths(schema, "", known);

    const rules = Object.keys(POLICY);
    const enums = enumsOf(schema);

    return {
        rules: rules.length,
        stray: rules.filter((key) => !known.has(key)),
        enumsLost: [
            ...(enums.statuses.size === 0 ? ["status"] : []),
            ...(enums.severities.size === 0 ? ["severity"] : []),
        ],
    };
}

export interface Checked {
    /** The value to write back, repairs applied and unrenderable entries gone. */
    merged: Record<string, unknown>;
    /** One line per repair, in the order they were made. */
    repairs: string[];
    /** One line per lens whose account of itself is missing from the review. */
    coverage: string[];
    /** Faults post-review.ts survives. The finding is kept. */
    warnings: Reported[];
    /** Faults outside `findings`, which cost a line of the review rather than a finding. */
    elsewhere: Reported[];
    /** Faults that took a finding with them. */
    dropped: Reported[];
    /** How many `resolve` or `lens_health` entries were dropped whole. */
    droppedEntries: number;
    /** How many findings the file arrived with. */
    found: number;
    /** How many are left. */
    kept: number;
    /** Whether anything above changed the value, so the caller knows to write it back. */
    changed: boolean;
}

/**
 * Whether every lens that ran has an account of itself in the review.
 *
 * `lens_health` is optional to the model and `composeReview` guards its whole block on the
 * array being non-empty, so one omitted array takes the lens list, the coverage alert and
 * every standing caveat out of the review at once, for every lens. A dropped entry does the
 * same for one lens. Neither is fatal, because the findings are still worth posting; both
 * are loud, because nothing downstream can tell an absent entry from a lens that did not run.
 *
 * Both sides go through `lensLabel`. `dispatched` is namespaced, because that is how
 * build-prompts.sh writes the lens list, and what the orchestrator puts in `lens_health` is
 * a plain string as far as the schema is concerned. Compared as written, an orchestrator that
 * dropped the namespace would put every lens that ran into this list at once, which is how a
 * coverage alarm becomes one people skip.
 */
function coverageOf(health: unknown[], dispatched: string[]): string[] {
    if (health.length === 0) {
        return ["lens_health: no entry, so the review says nothing about which lenses ran or what they missed"];
    }

    const named = new Set(
        health
            .map((entry) => record(entry)?.lens)
            .filter((lens) => typeof lens === "string")
            .map(lensLabel),
    );

    const silent = dispatched.map(lensLabel).filter((lens) => !named.has(lens));

    if (silent.length === 0) return [];

    return [`lens_health: ${silent.join(", ")} ran and reported no health, so the review leaves each one out`];
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
function keepEntries(merged: Record<string, unknown>, key: "resolve" | "lens_health", repairs: string[]): number {
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
}

/** Which finding a problem belongs to, or null for one about the file as a whole. */
function findingIndex(problem: Problem): number | null {
    const owner = problem.path.match(/^findings\[(\d+)\]/)?.[1];

    return owner === undefined ? null : Number(owner);
}

/**
 * Every rule, applied to one parsed findings file.
 *
 * The value is repaired in place and handed back, because the caller writes it out again.
 * `dispatched` is the lens list the run wrote beside the findings, empty for a by-hand check
 * of an old file, and then only the whole-array case of `coverageOf` is answerable.
 */
export function applyRules(schema: JsonSchema, merged: Record<string, unknown>, dispatched: string[]): Checked {
    const findings = Array.isArray(merged.findings) ? merged.findings : [];
    const found = findings.length;
    const repairs: string[] = [];

    // `posted` belongs to post-review.ts, which writes it once GitHub has accepted the
    // review. It is the only evidence fetch-previous.ts has that a run's findings were said
    // out loud, and this runs before anything is posted, so whatever put one here invented it.
    if (merged.posted !== undefined) {
        delete merged.posted;
        repairs.push("posted: removed. Only a review GitHub has accepted may record one");
    }

    const droppedEntries = keepEntries(merged, "resolve", repairs) + keepEntries(merged, "lens_health", repairs);

    const coverage = coverageOf(Array.isArray(merged.lens_health) ? merged.lens_health : [], dispatched);

    const problems: Problem[] = [];
    walk(merged, schema, "", problems, repairs, enumsOf(schema));

    // Read before anything is dropped, because the title comes out of the array by index.
    const label = (problem: Problem): string => {
        const owner = findingIndex(problem);
        if (owner === null) return problem.path || "findings.json";

        const raw = merged.findings;
        const title = Array.isArray(raw) ? record(raw[owner])?.title : undefined;

        return typeof title === "string" ? `${problem.path} (${title})` : problem.path;
    };

    const report = (problem: Problem): Reported => ({ label: label(problem), message: problem.message });

    const fatal = problems.filter((p) => !tolerated(p));

    // Everything under one finding, so that a finding with three faults is dropped once.
    const doomed = new Set<number>();
    for (const p of fatal) {
        const owner = findingIndex(p);
        if (owner !== null) doomed.add(owner);
    }

    // A fault outside `findings` costs a line of the review rather than a finding:
    // post-review.ts logs a GraphQL error and carries on for a thread id GitHub does not
    // know, and a findings_returned that is not a number renders as the word it is. What it
    // does not survive is a field it calls a string method on, which is why those entries are
    // checked rather than warned about.
    const checked: Checked = {
        merged,
        repairs,
        coverage,
        warnings: problems.filter(tolerated).map(report),
        elsewhere: fatal.filter((p) => findingIndex(p) === null).map(report),
        dropped: fatal.filter((p) => findingIndex(p) !== null).map(report),
        droppedEntries,
        found,
        kept: found - doomed.size,
        changed: doomed.size > 0 || droppedEntries > 0 || repairs.length > 0,
    };

    if (checked.changed) merged.findings = findings.filter((_, i) => !doomed.has(i));

    return checked;
}
