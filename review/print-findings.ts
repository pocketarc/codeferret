#!/usr/bin/env bun
/**
 * Print what a run found, for a terminal.
 *
 * `/codeferret:review` reads this out at the end of a run. It exists so that a session and
 * a posted review cannot disagree about what a review found: the partition, the vetting of
 * suppressions, the caveat a lens is held to and the position of a finding all come from
 * the same modules `post-review.ts` uses.
 *
 * What differs from the posted body is what suits a terminal. Findings are grouped by file
 * rather than ordered by severity, because whoever reads this opens the files next. Nothing
 * is escaped, because nothing here goes through GitHub's renderer. Severity and lens
 * agreement stay out for the reason `review/DECISIONS.md` gives: both are in the findings file.
 *
 * Usage: bun print-findings.ts <findings.json>
 */

import { dirname } from "node:path";
import { caveatOf, COVERAGE_NOTICES, coverageOf, noticesFor, reopenedReasons } from "./caveats.ts";
import { lensLabel, lineOf, partition } from "./findings.ts";
import { readMerged, runFacts, vetAgainstExisting } from "./read-run.ts";
import type { Finding } from "./findings.ts";
import { where } from "./review-body.ts";
import { plural } from "./words.ts";

const [findingsPath] = process.argv.slice(2);

if (!findingsPath) {
    console.error("usage: bun print-findings.ts <findings.json>");
    process.exit(2);
}

const findingsFile: string = findingsPath;
const buildDir = dirname(findingsFile);
const merged = await readMerged(findingsFile, (line) => console.error(line));

// A suppression the posting path would overturn has to be overturned here too, or a session
// reports as settled a finding a posted review would raise.
const vetted = await vetAgainstExisting(merged.findings, buildDir, (line) => console.error(line));
const { fresh, suppressed, declined } = partition(vetted.findings);

// The same sentences the posted path writes. Without them a session reopened a suppression
// and printed nothing about it, so whoever ran it read a finding they had already answered
// as one nobody had.
for (const said of reopenedReasons(vetted)) console.error(said);

/** By file, then by line within it, which is the order a reader opens them in. */
function byPosition(a: Finding, b: Finding): number {
    // A finding with no usable line sorts to the top of its file, which is where a reader
    // looking for the whole-file complaints expects it.
    const at = (f: Finding): number => lineOf(f) ?? 0;

    return a.file === b.file ? at(a) - at(b) : a.file.localeCompare(b.file);
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

const older = [...suppressed, ...declined];

// Listed, not counted. The posted body prints each of these with its file and title, and a
// session that reports only how many there were disagrees with the review it is standing in
// for: the reader cannot tell whether the thing they are looking at is among them.
if (older.length > 0) {
    out.push(`${plural(older.length, "finding")} raised before, in full in ${findingsFile}:`);

    for (const f of [...older].sort(byPosition)) {
        out.push(`  ${where(f)}: ${f.title}`);
    }
}

// The same derivation and the same sentences the posted body uses, in the same order, with
// nothing escaped: this goes to a terminal rather than through GitHub's renderer. The
// hand-built version had already lost the sentence about a half-read discussion, so a session
// printed reopened findings with nothing saying why, while a posted run explained it.
const coverage = coverageOf(merged, await runFacts(buildDir, vetted.existing));

for (const name of noticesFor(coverage)) out.push(COVERAGE_NOTICES[name].say(coverage, (text) => text));

for (const h of coverage.broken) {
    out.push(`${lensLabel(h.lens)} did not report normally: ${caveatOf(h) ?? "no detail given"}`);
}

// What this review did not cover, in the lens's own words and in the standing sentence for
// a lens that ships without the capability its skill describes. `caveatOf` rather than
// `detail`, because a terminal that leaves out "no page was rendered" reads as an
// accessibility pass just as a posted body would.
for (const h of coverage.health) {
    if (!h.ok) continue;

    const caveat = caveatOf(h);

    if (caveat) out.push(`${lensLabel(h.lens)}: ${caveat}`);
}

if (merged.notes) out.push(`Caveats: ${merged.notes}`);

console.log(out.join("\n\n"));

export {};
