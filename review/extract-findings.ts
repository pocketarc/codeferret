#!/usr/bin/env bun
/**
 * Pull the merged findings out of a Claude Code run log, and write down what the run cost.
 *
 * What comes out of this sits in the directory of the findings path: `findings.json`, and
 * the files `RUN_FILES` names. The action reads them as step outputs, and review/summary.ts
 * renders them into the job summary. The numbers are written before the findings are looked
 * at, because a run that produced none is the one whose cost and refusals somebody most
 * wants to see.
 *
 * The shape of a run log is upstream's, and a renamed field would report a $36 review as
 * $0.00 with nothing saying the number was not found. `runNumbers` in run-log.ts narrows each
 * one and sets what a missing one says.
 *
 * Usage: bun extract-findings.ts <run.json> <findings.json>
 */

import { dirname, join } from "node:path";
import type { LensHealth } from "./findings.ts";
import { number, record, string } from "./json.ts";
import { type RunNumberFile, UNREPORTED } from "./run-files.ts";
import { failureReason, lastResult, messagesOf, reportedNumbers, runNumbers } from "./run-log.ts";

/**
 * `LensHealth` as it arrives, before anything has checked a field.
 *
 * Every value is `unknown` because this module reads a run log a session wrote, and the
 * summary lines below narrow each field where they print it.
 */
type RawLensHealth = { [K in keyof LensHealth]?: unknown };

const [runPath, outPath] = process.argv.slice(2);

if (!runPath || !outPath) {
    console.error("usage: bun extract-findings.ts <run.json> <findings.json>");
    process.exit(2);
}

const { messages, unparsed } = messagesOf(await Bun.file(runPath).text());

if (unparsed > 0) {
    console.error(`the run log holds ${unparsed} line(s) that are not JSON, which a cut-off session leaves behind.`);
}

const last = lastResult(messages);
const dir = dirname(outPath);

/** The numbers a run reports, written together. `reportedNumbers` in run-log.ts has why. */
async function writeRunFiles(values: Record<RunNumberFile, string>): Promise<void> {
    for (const [file, value] of Object.entries(values)) {
        await Bun.write(join(dir, file), value);
    }
}

if (!last) {
    console.error("no result message in the run log. The session produced no terminal output.");

    // A killed session is exactly the run whose numbers somebody wants, so each is written
    // with what is known rather than left out to read as none.
    await writeRunFiles(UNREPORTED);

    process.exit(1);
}

// Read through the narrowers below rather than through an interface asserted over the
// message. The shape is upstream's, and a field it renamed would come back as a confident
// zero or a TypeError halfway through the reporting loop.
if (last.is_error === true) {
    console.error(`the run reported an error: ${failureReason(last)}`);
}

const numbers = runNumbers(last);
const { costUsd, denials, durationMs, outputTokens, perModel, refusals } = numbers;
const money = costUsd === null ? "unknown" : `$${costUsd.toFixed(2)}`;
const refused = refusals === null ? "an unknown number of tool calls" : `${refusals} tool call(s)`;

const structured = record(last.structured_output);
const findings = structured && Array.isArray(structured.findings) ? structured.findings : null;

// Before the findings are looked at, because a run that produced none is the one whose cost
// and refusals somebody most wants to see.
await writeRunFiles(reportedNumbers(numbers, findings));

if (!structured || findings === null) {
    console.error("the run produced no structured findings");

    // Only where the error line above did not already print it. A run that ended clean and
    // still returned nothing leaves the least behind, and is the case this line is for.
    if (last.is_error !== true) console.error(`the run ended: ${failureReason(last)}`);

    console.error(`it cost ${money} and was refused ${refused}`);
    process.exit(1);
}

await Bun.write(outPath, `${JSON.stringify(structured, null, 2)}\n`);

// Guarded like `findings` beside it. This is iterated below, after the findings file is
// already on disk, so a `lens_health` that is not a list would turn a complete run into a
// bare stack trace.
// The elements too, not just the container. `Array.isArray` says nothing about what is in
// the list, and a `null` entry reaches `h.ok` below and throws — after the findings file has
// been written, so a complete review dies on its own summary line.
const health: RawLensHealth[] = (Array.isArray(structured.lens_health) ? structured.lens_health : []).filter(
    (h): h is RawLensHealth => record(h) !== null,
);
const broken = health.filter((h) => h.ok === false);

console.log(`findings: ${findings.length}`);
console.log(`lenses reported: ${health.length}`);
console.log(`cost: ${money}`);
console.log(`output tokens: ${outputTokens === null ? "unknown" : outputTokens.toLocaleString("en-GB")}`);
console.log(`wall clock: ${durationMs === null ? "unknown" : `${(durationMs / 60000).toFixed(1)} min`}`);

for (const { model, outputTokens: spent, costUSD } of perModel) {
    console.log(`  ${model}: ${spent.toLocaleString("en-GB")} out, $${costUSD.toFixed(2)}`);
}

for (const h of health) {
    const status = h.ok === false ? "NEEDS ATTENTION" : "ok";
    const detail = string(h.detail);

    console.log(
        `  ${string(h.lens) ?? "?"}: ${number(h.findings_returned) ?? "?"} findings,` +
            ` ${status}${detail ? ` (${detail})` : ""}`,
    );
}

if (broken.length > 0) {
    console.log(`\n${broken.length} lens(es) did not report normally. The review is less complete than it looks.`);
}

if (denials.length > 0) {
    console.log(`\n${denials.length} tool call(s) were refused by the permission mode:`);
    for (const d of denials) {
        const input = record(d.tool_input);
        const what = string(input?.command) ?? JSON.stringify(input ?? {});
        console.log(`  ${string(d.tool_name) ?? "?"}: ${what.slice(0, 120)}`);
    }
    console.log("A lens that could not run what it needed covered less than its report suggests.");
}
