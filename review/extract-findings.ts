#!/usr/bin/env bun
/**
 * Pull the merged findings out of a Claude Code run log.
 *
 * The orchestrator emits a fresh structured output each time a lens reports back, so
 * the log holds several `result` messages and only the last is complete.
 *
 * Usage: bun extract-findings.ts <run.json> <findings.json>
 */

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

const countPath = `${outPath.replace(/\/[^/]*$/, "")}/findings-count`;
await Bun.write(countPath, String(structured.findings.length));

const health = structured.lens_health ?? [];
const broken = health.filter((h: { ok?: boolean }) => h.ok === false);

console.log(`findings: ${structured.findings.length}`);
console.log(`lenses reported: ${health.length}`);

for (const h of health) {
    const status = h.ok === false ? "NEEDS ATTENTION" : "ok";
    console.log(`  ${h.lens}: ${h.findings_returned} findings — ${status}${h.detail ? ` (${h.detail})` : ""}`);
}

if (broken.length > 0) {
    console.log(`\n${broken.length} lens(es) did not report normally; the review is less complete than it looks.`);
}
