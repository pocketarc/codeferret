#!/usr/bin/env bun
/**
 * Pull the merged findings out of a Claude Code run log, and write down what the run cost.
 *
 * The orchestrator emits a fresh structured output each time a lens reports back, so
 * the log holds several `result` messages and only the last is complete.
 *
 * What comes out of this sits in the directory of the findings path: `findings.json`, and
 * the files `RUN_FILES` names. The action reads them as step outputs, and review/summary.ts
 * renders them into the job summary. The numbers are written before the findings are looked
 * at, because a run that produced none is the one whose cost and refusals somebody most
 * wants to see.
 *
 * The shape of a run log is upstream's, and a renamed field would report a $36 review as
 * $0.00 with nothing saying the number was not found, so each one is narrowed on the way
 * out and the fallbacks below say what a missing one looks like.
 *
 * Usage: bun extract-findings.ts <run.json> <findings.json>
 */

import { dirname, join } from "node:path";
import { record } from "./json.ts";
import { RUN_FILES } from "./run-files.ts";

interface LensHealth {
    lens?: unknown;
    findings_returned?: unknown;
    ok?: unknown;
    detail?: unknown;
}

const [runPath, outPath] = process.argv.slice(2);

if (!runPath || !outPath) {
    console.error("usage: bun extract-findings.ts <run.json> <findings.json>");
    process.exit(2);
}

function number(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

const text = await Bun.file(runPath).text();

let messages: unknown[];
try {
    const parsed: unknown = JSON.parse(text);
    messages = Array.isArray(parsed) ? parsed : [parsed];
} catch {
    // Each line in a `try` of its own. A log cut off mid-line is exactly what a killed or
    // out-of-memory session leaves behind, and that is the run whose cost and refusals
    // somebody most wants to see: one throw here and none of the numbers below is ever
    // written.
    messages = [];

    for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;

        try {
            messages.push(JSON.parse(line) as unknown);
        } catch {
            console.error("the run log holds a line that is not JSON, which a cut-off session leaves behind.");
        }
    }
}

const results = messages.map(record).filter((m) => m !== null && m.type === "result");
const last = results[results.length - 1];
const dir = dirname(outPath);

/** Every run file this script owns. `findingsChecked` is run.sh's and is not written here. */
type Reported = Exclude<(typeof RUN_FILES)[keyof typeof RUN_FILES], typeof RUN_FILES.findingsChecked>;

/**
 * The numbers a run reports, written together.
 *
 * The set is the contract, not any one name. To every reader an absent file is
 * indistinguishable from a zero, and `unknown` is what a killed session writes, so a file
 * added on one path and forgotten on the other is taken for a killed session on a run that
 * worked. Taking the whole record makes the compiler require every name on both paths.
 */
async function writeRunFiles(values: Record<Reported, string>): Promise<void> {
    for (const [file, value] of Object.entries(values)) {
        await Bun.write(join(dir, file), value);
    }
}

if (!last) {
    console.error("no result message in the run log. The session produced no terminal output.");

    // A killed session is exactly the run whose numbers somebody wants, so each is written
    // with what is known rather than left out to read as none.
    await writeRunFiles({
        [RUN_FILES.findingsCount]: "none reported",
        [RUN_FILES.cost]: "unknown",
        [RUN_FILES.outputTokens]: "unknown",
        [RUN_FILES.durationMs]: "unknown",
        [RUN_FILES.permissionDenials]: "unknown",
    });

    process.exit(1);
}

// Read through the narrowers below rather than through an interface asserted over the
// message. The shape is upstream's, and a field it renamed would come back as a confident
// zero or a TypeError halfway through the reporting loop.
if (last.is_error === true) {
    console.error(`the run reported an error: ${string(last.subtype) ?? "unknown"}`);
}

// The result's `usage` counts the orchestrator's last turn and nothing else. Only
// `modelUsage` covers the subagents, which is where a lens run spends everything: over a
// full set of lenses the two differ by a factor of sixty.
const models = record(last.modelUsage);
const perModel = models ? Object.entries(models).map(([name, usage]) => [name, record(usage)] as const) : [];

const outputTokens = perModel.reduce((total, [, usage]) => total + (number(usage?.outputTokens) ?? 0), 0);

const summed = perModel.reduce((total, [, usage]) => total + (number(usage?.costUSD) ?? 0), 0);
const reported = number(last.total_cost_usd);

/**
 * What the run cost, across the three answers a log can give.
 *
 * A subscription-billed run has been seen to report `total_cost_usd` as zero while the
 * modelUsage figures said otherwise, and zero is the number a reader takes for a free $36
 * review on every surface this reaches. So a reported zero falls through to the sum, and
 * only an empty `modelUsage` falls back to it: `record({})` is not null, so testing for the
 * object rather than for its entries produces the confident 0.00 this exists to avoid.
 */
function totalCost(reported: number | null, summed: number, models: number): number | null {
    if (reported) return reported;
    if (models > 0) return summed;

    // Null where the log carried neither, which is what a shape that has moved looks like.
    // A reported zero with nothing to sum stays zero.
    return reported;
}

const costUsd = totalCost(reported, summed, perModel.length);
const durationMs = number(last.duration_ms) ?? 0;
const money = costUsd === null ? "unknown" : `$${costUsd.toFixed(2)}`;

// Narrowed element by element, not just as a container. This list is read in the reporting
// loop at the end, after the findings file is on disk, and a null or a string in it would
// turn a complete run into a stack trace over the one report saying what a lens was refused.
const denials = (Array.isArray(last.permission_denials) ? last.permission_denials : [])
    .map(record)
    .filter((d) => d !== null);

const structured = record(last.structured_output);
const findings = structured && Array.isArray(structured.findings) ? structured.findings : null;

// Before the findings are looked at, because a run that produced none is the one whose cost
// and refusals somebody most wants to see.
await writeRunFiles({
    [RUN_FILES.findingsCount]: findings === null ? "none reported" : String(findings.length),
    [RUN_FILES.cost]: costUsd === null ? "unknown" : costUsd.toFixed(2),
    [RUN_FILES.outputTokens]: String(outputTokens),
    [RUN_FILES.durationMs]: String(durationMs),
    [RUN_FILES.permissionDenials]: String(denials.length),
});

if (!structured || findings === null) {
    console.error("the run produced no structured findings");
    console.error(`result subtype: ${string(last.subtype) ?? "unknown"}`);
    console.error(`it cost ${money} and was refused ${denials.length} tool call(s)`);
    process.exit(1);
}

await Bun.write(outPath, `${JSON.stringify(structured, null, 2)}\n`);

// Guarded like `findings` beside it. This is iterated below, after the findings file is
// already on disk, so a `lens_health` that is not a list would turn a complete run into a
// bare stack trace.
const health: LensHealth[] = Array.isArray(structured.lens_health) ? structured.lens_health : [];
const broken = health.filter((h) => record(h)?.ok === false);

console.log(`findings: ${findings.length}`);
console.log(`lenses reported: ${health.length}`);
console.log(`cost: ${money}`);
console.log(`output tokens: ${outputTokens.toLocaleString("en-GB")}`);
console.log(`wall clock: ${(durationMs / 60000).toFixed(1)} min`);

for (const [model, usage] of perModel) {
    const tokens = (number(usage?.outputTokens) ?? 0).toLocaleString("en-GB");
    console.log(`  ${model}: ${tokens} out, $${(number(usage?.costUSD) ?? 0).toFixed(2)}`);
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
