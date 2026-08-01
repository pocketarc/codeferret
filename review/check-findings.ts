#!/usr/bin/env bun
/**
 * Check merged findings against the shape post-review.ts reads, and drop what it cannot use.
 *
 * The action and `/codeferret:review` both run the orchestrator under `--json-schema`,
 * but that is a request to the model rather than a check on what comes back, and
 * post-review.ts validates nothing it is handed. So this is the only thing standing
 * between the orchestrator's output and a posted review: a finding with no `status` is
 * posted as new, one with no `title` is a bullet with no claim on it, and a `file` with a
 * leading slash is a path nobody can open. All three look like an ordinary review.
 *
 * The shape itself is read out of merged-schema.json rather than mirrored here, so the
 * contract has one home. Three rules the schema cannot state are added below.
 *
 * A finding this cannot use is dropped and the rest are written back. Failing the file
 * would throw away a review that took twenty minutes and tens of dollars to produce, over
 * one finding among a hundred; the exit code still says the run went wrong.
 *
 * Usage: bun check-findings.ts <findings.json>
 *
 * Exit: 0 nothing wrong, 3 something was dropped and the rest is worth posting,
 *       1 nothing usable is left.
 */

import { join } from "node:path";

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

const [path] = process.argv.slice(2);

if (!path) {
    console.error("usage: bun check-findings.ts <findings.json>");
    process.exit(2);
}

/**
 * The rules that decide a posted review and that JSON Schema cannot express.
 *
 * Keyed by the path the walk builds, with an array index written as `[]`.
 */
const EXTRA: Record<string, (value: unknown) => string | null> = {
    "findings[].line": positive,
    "findings[].end_line": positive,
    "findings[].file": (value) =>
        typeof value === "string" && value.startsWith("/")
            ? `must be repo-relative, got '${value}'`
            : null,
};

/**
 * Faults post-review.ts survives, so none of them is worth losing a finding over.
 *
 * `found_by` and `in_diff` are never read. A finding with no usable `line` is listed under
 * its file alone, which is worth more to a reader than a finding nobody sees.
 */
const TOLERATED = new Set([
    "findings[].found_by",
    "findings[].in_diff",
    "findings[].line",
    "findings[].end_line",
]);

function positive(value: unknown): string | null {
    return typeof value === "number" && value < 1 ? `must be 1 or more, got ${value}` : null;
}

function record(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

/** The path with every array index replaced by `[]`, which is how the tables above are keyed. */
function shape(path: string): string {
    return path.replace(/\[\d+\]/g, "[]");
}

function walk(value: unknown, node: JsonSchema, path: string, out: Problem[]): void {
    const problem = (message: string): void => {
        out.push({ path, message });
    };

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

        // Reported against the missing field's own path, so that the tables above can
        // name it the way they name a field that is present and wrong.
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
            if (object[key] !== undefined) walk(object[key], child, path ? `${path}.${key}` : key, out);
        }

        return;
    }

    if (node.type === "array") {
        if (!Array.isArray(value)) {
            problem(`must be an array, got ${JSON.stringify(value)}`);
            return;
        }

        if (node.items) {
            value.forEach((item, i) => walk(item, node.items as JsonSchema, `${path}[${i}]`, out));
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

    const extra = EXTRA[shape(path)];
    const complaint = extra?.(value);
    if (complaint) problem(complaint);
}

const schema = JSON.parse(await Bun.file(join(import.meta.dir, "merged-schema.json")).text()) as JsonSchema;

let parsed: unknown;

try {
    parsed = JSON.parse(await Bun.file(path).text());
} catch (error) {
    console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
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
const problems: Problem[] = [];

walk(merged, schema, "", problems);

// A finding used to have to name the comment that covered it before it could be called
// `already-reported`. Most cannot now: the match is against the previous run's
// findings file rather than against a thread, and a review body is not a comment anyone
// can link to. The url is still copied where a thread is what settled it, and the review
// renders the link only when it is there.

const label = (problem: Problem): string => {
    const owner = problem.path.match(/^findings\[(\d+)\]/)?.[1];
    if (owner === undefined) return problem.path || "findings.json";

    const raw = merged.findings;
    const title = Array.isArray(raw) ? record(raw[Number(owner)])?.title : undefined;

    return typeof title === "string" ? `${problem.path} (${title})` : problem.path;
};

const fatal = problems.filter((p) => !TOLERATED.has(shape(p.path)));
const warnings = problems.filter((p) => TOLERATED.has(shape(p.path)));

// Everything under one finding, so that a finding with three faults is dropped once.
const doomed = new Set<number>();

for (const p of fatal) {
    const owner = p.path.match(/^findings\[(\d+)\]/)?.[1];
    if (owner !== undefined) doomed.add(Number(owner));
}

// A fault outside `findings` never drops anything: post-review.ts logs a GraphQL error and
// carries on for a bad `thread_id`, and renders lens_health as prose. A non-object entry is
// the exception, because it throws where the script reads a field off it.
const elsewhere = fatal.filter((p) => !/^findings\[/.test(p.path));

const keepEntries = (key: "resolve" | "lens_health"): number => {
    const list = merged[key];
    if (!Array.isArray(list)) return 0;

    const kept = list.filter((entry) => record(entry) !== null);
    const dropped = list.length - kept.length;
    if (dropped > 0) merged[key] = kept;

    return dropped;
};

const droppedEntries = keepEntries("resolve") + keepEntries("lens_health");

for (const w of warnings) console.warn(`WARN ${label(w)}: ${w.message}`);
for (const p of elsewhere) console.warn(`WARN ${label(p)}: ${p.message}`);
for (const p of fatal.filter((x) => /^findings\[/.test(x.path))) {
    console.error(`DROP ${label(p)}: ${p.message}`);
}

if (doomed.size > 0 || droppedEntries > 0) {
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

const noted = warnings.length + elsewhere.length;
console.log(`OK ${path}: ${kept} finding(s), shape valid${noted > 0 ? `, ${noted} worth a look` : ""}`);
