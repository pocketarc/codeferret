#!/usr/bin/env bun
/**
 * Pull the merged findings out of a Claude Code run log, and write down what the run cost.
 *
 * The orchestrator emits a fresh structured output each time a lens reports back, so
 * the log holds several `result` messages and only the last is complete.
 *
 * Six files come out of this, all in the directory of the findings path: `findings.json`,
 * `findings-count`, `cost-usd`, `output-tokens`, `duration-ms` and `permission-denials`.
 * The action reads every one of them, and review/summary.ts renders them into the job
 * summary. The four numbers are written before the findings are looked at, because a run
 * that produced none is the one whose cost and refusals somebody most wants to see.
 *
 * The shape of a run log is upstream's, and a renamed field would report a $36 review as
 * $0.00 with nothing saying the number was not found, so each one is narrowed on the way
 * out and the fallbacks below say what a missing one looks like.
 *
 * Usage: bun extract-findings.ts <run.json> <findings.json>
 */

import { dirname, join } from "node:path";
import { record } from "./json.ts";

interface Denial {
    tool_name?: string;
    tool_input?: { command?: string };
}

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
    // somebody most wants to see: one throw here and none of the four numbers below is ever
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

if (!last) {
    console.error("no result message in the run log. The session produced no terminal output.");
    process.exit(1);
}

// Read through the narrowers below rather than through an interface asserted over the
// message. The shape is upstream's, and a field it renamed would come back as a confident
// zero or a TypeError halfway through the reporting loop.
if (last.is_error === true) {
    console.error(`the run reported an error: ${string(last.subtype) ?? "unknown"}`);
}

const dir = dirname(outPath);

// The result's `usage` counts the orchestrator's last turn and nothing else. Only
// `modelUsage` covers the subagents, which is where a lens run spends everything: over a
// full set of lenses the two differ by a factor of sixty.
const models = record(last.modelUsage);
const perModel = models ? Object.entries(models).map(([name, usage]) => [name, record(usage)] as const) : [];

const outputTokens = perModel.reduce((total, [, usage]) => total + (number(usage?.outputTokens) ?? 0), 0);

const summed = perModel.reduce((total, [, usage]) => total + (number(usage?.costUSD) ?? 0), 0);
const reported = number(last.total_cost_usd);

// A subscription-billed run has been seen to report `total_cost_usd` as zero while the
// modelUsage figures said otherwise, and zero is the number a reader takes for a free $36
// review on every surface this reaches. So a reported zero falls through to the sum, and
// only an empty `modelUsage` falls back to it: `record({})` is not null, so testing for
// the object rather than for its entries produces the confident 0.00 this exists to avoid.
//
// Null when the log carried neither, which is what a shape that has moved looks like.
const costUsd: number | null = reported || (perModel.length > 0 ? summed : reported);
const durationMs = number(last.duration_ms) ?? 0;
const money = costUsd === null ? "unknown" : `$${costUsd.toFixed(2)}`;

const denials: Denial[] = Array.isArray(last.permission_denials) ? last.permission_denials : [];

await Bun.write(join(dir, "cost-usd"), costUsd === null ? "unknown" : costUsd.toFixed(2));
await Bun.write(join(dir, "output-tokens"), String(outputTokens));
await Bun.write(join(dir, "duration-ms"), String(durationMs));
await Bun.write(join(dir, "permission-denials"), String(denials.length));

const structured = record(last.structured_output);

if (!structured || !Array.isArray(structured.findings)) {
    await Bun.write(join(dir, "findings-count"), "none reported");
    console.error("the run produced no structured findings");
    console.error(`result subtype: ${string(last.subtype) ?? "unknown"}`);
    console.error(`it cost ${money} and was refused ${denials.length} tool call(s)`);
    process.exit(1);
}

await Bun.write(outPath, `${JSON.stringify(structured, null, 2)}\n`);
await Bun.write(join(dir, "findings-count"), String(structured.findings.length));

// Guarded like `findings` beside it. This is iterated below, after the findings file is
// already on disk, so a `lens_health` that is not a list would turn a complete run into a
// bare stack trace.
const health: LensHealth[] = Array.isArray(structured.lens_health) ? structured.lens_health : [];
const broken = health.filter((h) => record(h)?.ok === false);

console.log(`findings: ${structured.findings.length}`);
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
    console.log(`\n${broken.length} lens(es) did not report normally; the review is less complete than it looks.`);
}

if (denials.length > 0) {
    console.log(`\n${denials.length} tool call(s) were refused by the permission mode:`);
    for (const d of denials) {
        const what = d.tool_input?.command ?? JSON.stringify(d.tool_input ?? {});
        console.log(`  ${d.tool_name ?? "?"}: ${String(what).slice(0, 120)}`);
    }
    console.log("A lens that could not run what it needed covered less than its report suggests.");
}
