#!/usr/bin/env bun
/**
 * Pull the merged findings out of a Claude Code run log.
 *
 * The orchestrator emits a fresh structured output each time a lens reports back, so
 * the log holds several `result` messages and only the last is complete.
 *
 * Usage: bun extract-findings.ts <run.json> <findings.json>
 */

import { dirname, join } from "node:path";

const [runPath, outPath] = process.argv.slice(2);

if (!runPath || !outPath) {
    console.error("usage: bun extract-findings.ts <run.json> <findings.json>");
    process.exit(2);
}

const text = await Bun.file(runPath).text();

let messages: Record<string, any>[];
try {
    const parsed = JSON.parse(text);
    messages = Array.isArray(parsed) ? parsed : [parsed];
} catch {
    messages = text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
}

const results = messages.filter((m) => m.type === "result");
const last = results[results.length - 1];

if (!last) {
    console.error("no result message in the run log — the session produced no terminal output");
    process.exit(1);
}

if (last.is_error) {
    console.error(`the run reported an error: ${last.subtype ?? "unknown"}`);
}

const structured = last.structured_output;

if (!structured || !Array.isArray(structured.findings)) {
    console.error("the run produced no structured findings");
    console.error(`result subtype: ${last.subtype ?? "unknown"}`);
    process.exit(1);
}

await Bun.write(outPath, `${JSON.stringify(structured, null, 2)}\n`);

const dir = dirname(outPath);
await Bun.write(join(dir, "findings-count"), String(structured.findings.length));

// The result's `usage` counts the orchestrator's last turn and nothing else. Only
// `modelUsage` covers the subagents, which is where a lens run spends everything: on a
// twelve-lens review the two differ by a factor of sixty.
const models: Record<string, { outputTokens?: number; costUSD?: number }> = last.modelUsage ?? {};
const outputTokens = Object.values(models).reduce((total, m) => total + (m.outputTokens ?? 0), 0);
const costUsd =
    last.total_cost_usd ?? Object.values(models).reduce((total, m) => total + (m.costUSD ?? 0), 0);
const durationMs = last.duration_ms ?? 0;

// A permission mode that refuses something a lens needed narrows the review without
// narrowing anything a reader can see. Same argument as lens_health: it becomes a
// number, or it becomes silence.
const denials: Array<{ tool_name?: string; tool_input?: { command?: string } }> = Array.isArray(
    last.permission_denials,
)
    ? last.permission_denials
    : [];

await Bun.write(join(dir, "cost-usd"), costUsd.toFixed(2));
await Bun.write(join(dir, "output-tokens"), String(outputTokens));
await Bun.write(join(dir, "duration-ms"), String(durationMs));
await Bun.write(join(dir, "permission-denials"), String(denials.length));

const health = structured.lens_health ?? [];
const broken = health.filter((h: { ok?: boolean }) => h.ok === false);

console.log(`findings: ${structured.findings.length}`);
console.log(`lenses reported: ${health.length}`);
console.log(`cost: $${costUsd.toFixed(2)}`);
console.log(`output tokens: ${outputTokens.toLocaleString("en-GB")}`);
console.log(`wall clock: ${(durationMs / 60000).toFixed(1)} min`);

for (const [model, usage] of Object.entries(models)) {
    console.log(`  ${model}: ${(usage.outputTokens ?? 0).toLocaleString("en-GB")} out, $${(usage.costUSD ?? 0).toFixed(2)}`);
}

for (const h of health) {
    const status = h.ok === false ? "NEEDS ATTENTION" : "ok";
    console.log(`  ${h.lens}: ${h.findings_returned} findings — ${status}${h.detail ? ` (${h.detail})` : ""}`);
}

if (broken.length > 0) {
    console.log(`\n${broken.length} lens(es) did not report normally; the review is less complete than it looks.`);
}

if (denials.length > 0) {
    console.log(`\n${denials.length} tool call(s) were refused by the permission mode:`);
    for (const d of denials) {
        console.log(`  ${d.tool_name ?? "?"}: ${d.tool_input?.command ?? JSON.stringify(d.tool_input).slice(0, 120)}`);
    }
    console.log("A lens that could not run what it needed reviewed less than it appears to.");
}
