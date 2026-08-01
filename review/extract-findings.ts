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
    console.error("no result message in the run log. The session produced no terminal output.");
    process.exit(1);
}

if (last.is_error) {
    console.error(`the run reported an error: ${last.subtype ?? "unknown"}`);
}

const dir = dirname(outPath);

// The result's `usage` counts the orchestrator's last turn and nothing else. Only
// `modelUsage` covers the subagents, which is where a lens run spends everything: on a
// twelve-lens review the two differ by a factor of sixty.
const models: Record<string, { outputTokens?: number; costUSD?: number }> = last.modelUsage ?? {};
const outputTokens = Object.values(models).reduce((total, m) => total + (m.outputTokens ?? 0), 0);

// `||` and not `??`: a subscription-billed run has been seen to report `total_cost_usd`
// as a number the modelUsage figures contradict, and zero is the value that reads as a
// free $36 review on every surface this number reaches.
const costUsd =
    last.total_cost_usd || Object.values(models).reduce((total, m) => total + (m.costUSD ?? 0), 0);
const durationMs = last.duration_ms ?? 0;

const denials: Array<{ tool_name?: string; tool_input?: { command?: string } }> = Array.isArray(
    last.permission_denials,
)
    ? last.permission_denials
    : [];

// Written before the findings are looked at, because a run that produced none is the one
// whose cost and refusals somebody most wants to see.
await Bun.write(join(dir, "cost-usd"), costUsd.toFixed(2));
await Bun.write(join(dir, "output-tokens"), String(outputTokens));
await Bun.write(join(dir, "duration-ms"), String(durationMs));
await Bun.write(join(dir, "permission-denials"), String(denials.length));

// Rendered here rather than in the action's step, so that the shell reformats no
// duration and guards no missing file, and so both surfaces round the same way.
async function writeSummary(findingsCount: string): Promise<void> {
    const rows: Array<[string, string]> = [
        ["Findings", findingsCount],
        ["Cost", `$${costUsd.toFixed(2)}`],
        ["Output tokens", outputTokens.toLocaleString("en-GB")],
        ["Wall clock", `${(durationMs / 60000).toFixed(1)} min`],
    ];

    const table = `### CodeFerret\n\n| Measure | Value |\n|---|---|\n${rows
        .map(([measure, value]) => `| ${measure} | ${value} |`)
        .join("\n")}\n`;

    const refusals =
        denials.length > 0
            ? `\n> [!WARNING]\n> ${denials.length} tool calls were refused. The review covers less than this summary suggests.\n`
            : "";

    await Bun.write(join(dir, "summary.md"), table + refusals);
}

const structured = last.structured_output;

if (!structured || !Array.isArray(structured.findings)) {
    await writeSummary("none reported");
    console.error("the run produced no structured findings");
    console.error(`result subtype: ${last.subtype ?? "unknown"}`);
    console.error(`it cost $${costUsd.toFixed(2)} and was refused ${denials.length} tool call(s)`);
    process.exit(1);
}

await Bun.write(outPath, `${JSON.stringify(structured, null, 2)}\n`);
await Bun.write(join(dir, "findings-count"), String(structured.findings.length));
await writeSummary(String(structured.findings.length));

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
    console.log(`  ${h.lens}: ${h.findings_returned} findings, ${status}${h.detail ? ` (${h.detail})` : ""}`);
}

if (broken.length > 0) {
    console.log(`\n${broken.length} lens(es) did not report normally; the review is less complete than it looks.`);
}

if (denials.length > 0) {
    console.log(`\n${denials.length} tool call(s) were refused by the permission mode:`);
    for (const d of denials) {
        // A denial carrying no tool_input prints as `{}`, which says the field was
        // absent. Without the `?? {}` it prints the word "undefined", which reads as a
        // value the harness sent.
        const what = d.tool_input?.command ?? JSON.stringify(d.tool_input ?? {});
        console.log(`  ${d.tool_name ?? "?"}: ${String(what).slice(0, 120)}`);
    }
    console.log("A lens that could not run what it needed covered less than its report suggests.");
}
