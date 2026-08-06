#!/usr/bin/env bun
/**
 * Render the GitHub Actions job summary from the numbers a run wrote.
 *
 * Every value is read back off disk rather than passed in, so a run that died partway
 * still reports whatever it managed to write.
 *
 * Usage: bun review/summary.ts <build-dir> [<exit-status>]
 */

import { join } from "node:path";

const [buildDir, exitStatus] = process.argv.slice(2);

if (!buildDir) {
    console.error("usage: bun review/summary.ts <build-dir> [<exit-status>]");
    process.exit(2);
}

async function value(name: string): Promise<string | null> {
    const file = Bun.file(join(buildDir ?? "", name));
    return (await file.exists()) ? (await file.text()).trim() : null;
}

const findings = (await value("findings-count")) ?? "none reported";
const cost = await value("cost-usd");
const tokens = await value("output-tokens");
const durationMs = await value("duration-ms");
const denials = Number(await value("permission-denials")) || 0;

const rows: Array<[string, string]> = [
    ["Findings", findings],
    ["Cost", cost === null || cost === "unknown" ? "unknown" : `$${cost}`],
    ["Output tokens", tokens === null ? "unknown" : Number(tokens).toLocaleString("en-GB")],
    ["Wall clock", durationMs === null ? "unknown" : `${(Number(durationMs) / 60000).toFixed(1)} min`],
];

const table = `### CodeFerret\n\n| Measure | Value |\n|---|---|\n${rows
    .map(([measure, reading]) => `| ${measure} | ${reading} |`)
    .join("\n")}\n`;

// One refusal is the commonest case, and this is the headline warning on the run's page.
const refused = denials === 1 ? "1 tool call was" : `${denials} tool calls were`;

const refusals =
    denials > 0
        ? `\n> [!WARNING]\n> ${refused} refused. The review covers less than this summary suggests.\n`
        : "";

const failed =
    exitStatus !== undefined && exitStatus !== "0"
        ? "\n> [!WARNING]\n> The review failed. Read the step log.\n"
        : "";

process.stdout.write(table + refusals + failed);
