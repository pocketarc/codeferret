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
 * agreement stay out for the reason `review/README.md` gives: both are in the findings file.
 *
 * Usage: bun print-findings.ts <findings.json>
 */

import { dirname } from "node:path";
import { brokenLenses, lensLabel, partition, readMerged, silentLenses, vetAgainstExisting } from "./findings.ts";
import type { Finding } from "./findings.ts";
import { caveatOf, plural, where } from "./review-body.ts";
import { readDispatched } from "./run-files.ts";

const [findingsPath] = process.argv.slice(2);

if (!findingsPath) {
    console.error("usage: bun print-findings.ts <findings.json>");
    process.exit(2);
}

const findingsFile: string = findingsPath;
const merged = await readMerged(findingsFile);

// A suppression the posting path would overturn has to be overturned here too, or a session
// reports as settled a finding a posted review would raise.
const vetted = await vetAgainstExisting(merged.findings, dirname(findingsFile));
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
    out.push(`${findingsFile} holds ${plural(older, "finding")} raised before.`);
}

const health = merged.lens_health ?? [];
const broken = brokenLenses(health);

// For the reason the posted body says it: a lens the orchestrator left out of `lens_health`
// is a lens this listing has nothing at all to say about, and silence here is taken for a
// lens that had nothing to report.
const silent = silentLenses(
    health.map((h) => h.lens),
    await readDispatched(dirname(findingsFile)),
);

if (silent.length > 0) {
    out.push(`${silent.join(", ")} ran and reported nothing about themselves, so this leaves each one out.`);
}

for (const h of broken) {
    out.push(`${lensLabel(h.lens)} did not report normally: ${caveatOf(h) ?? "no detail given"}`);
}

// What this review did not cover, in the lens's own words and in the standing sentence for
// a lens that ships without the capability its skill describes. `caveatOf` rather than
// `detail`, because a terminal that leaves out "no page was rendered" reads as an
// accessibility pass just as a posted body would.
for (const h of health) {
    if (!h.ok) continue;

    const caveat = caveatOf(h);

    if (caveat) out.push(`${lensLabel(h.lens)}: ${caveat}`);
}

if (merged.notes) out.push(`Caveats: ${merged.notes}`);

console.log(out.join("\n\n"));

export {};
