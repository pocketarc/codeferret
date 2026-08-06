#!/usr/bin/env bun
/**
 * Print what a run found, for a terminal.
 *
 * `/codeferret:review` reads this out at the end of a run. It exists so that a session and
 * a posted review cannot disagree about what a review found: the partition, the vetting of
 * declines and the position of a finding all come from the same modules `post-review.ts`
 * uses. The prose rules it replaces were a second implementation kept in step by hand.
 *
 * What differs from the posted body is what suits a terminal. Findings are grouped by file
 * rather than ordered by severity, because whoever reads this opens the files next. Nothing
 * is escaped, because nothing here goes through GitHub's renderer. Severity and lens
 * agreement stay out for the reason `review/README.md` gives: both are in the findings file.
 *
 * Usage: bun print-findings.ts <findings.json>
 */

import { dirname, join } from "node:path";
import { brokenLenses, partition, plural, vetDeclines } from "./findings.ts";
import type { Finding, Merged } from "./findings.ts";
import { reason } from "./json.ts";
import { lensLabel, where } from "./review-body.ts";

const [findingsPath] = process.argv.slice(2);

if (!findingsPath) {
    console.error("usage: bun print-findings.ts <findings.json>");
    process.exit(2);
}

const findingsFile: string = findingsPath;

let merged: Merged;

try {
    merged = JSON.parse(await Bun.file(findingsFile).text()) as Merged;
} catch (error) {
    console.error(`${findingsFile}: ${reason(error)}`);
    process.exit(1);
}

if (typeof merged !== "object" || merged === null || !Array.isArray(merged.findings)) {
    console.error(`${findingsFile}: has no \`findings\` array`);
    process.exit(1);
}

/** The comments the run read, when there was a pull request to read them from. */
async function readExisting(): Promise<unknown> {
    const file = Bun.file(join(dirname(findingsFile), "existing.json"));

    if (!(await file.exists())) return {};

    try {
        return JSON.parse(await file.text());
    } catch {
        return {};
    }
}

// A decline the posting path would overturn has to be overturned here too, or a session
// reports as settled a finding a posted review would raise.
const vetted = vetDeclines(merged.findings, await readExisting());
const { fresh, suppressed, declined } = partition(vetted.findings);

/** By file, then by line within it, which is the order a reader opens them in. */
function byPosition(a: Finding, b: Finding): number {
    const lineOf = (f: Finding): number => (Number.isInteger(f.line) ? f.line : 0);

    return a.file === b.file ? lineOf(a) - lineOf(b) : a.file.localeCompare(b.file);
}

const out: string[] = [];

if (merged.summary) out.push(merged.summary);

if (fresh.length === 0) {
    out.push("No new findings.");
} else {
    for (const f of [...fresh].sort(byPosition)) {
        out.push(`${where(f)}: ${f.title}`, f.body);
    }
}

const older = suppressed.length + declined.length;

if (older > 0) {
    out.push(`${plural(older, "finding")} were raised before and are in ${findingsFile}.`);
}

const health = merged.lens_health ?? [];
const broken = brokenLenses(health);

for (const h of broken) {
    out.push(`${lensLabel(h.lens)} did not report normally: ${h.detail ?? "no detail given"}`);
}

// A working domain lens with nothing in its domain: not a failure, but the one line saying
// what this review did not cover.
for (const h of health) {
    if (!h.ok || !h.detail) continue;

    out.push(`${lensLabel(h.lens)}: ${h.detail}`);
}

if (merged.notes) out.push(`Caveats: ${merged.notes}`);

console.log(out.join("\n\n"));

export {};
