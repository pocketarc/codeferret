#!/usr/bin/env bun
/**
 * Render the GitHub Actions job summary from the numbers a run wrote.
 *
 * Every value is read back off disk, so a run that died partway still reports whatever it
 * managed to write.
 *
 * Usage: bun review/summary.ts <build-dir> [<exit-status>]
 */

import { join } from "node:path";
import { record } from "./json.ts";

const [buildDir, exitStatus] = process.argv.slice(2);

if (!buildDir) {
    console.error("usage: bun review/summary.ts <build-dir> [<exit-status>]");
    process.exit(2);
}

const dir: string = buildDir;

async function value(name: string): Promise<string | null> {
    const file = Bun.file(join(dir, name));
    return (await file.exists()) ? (await file.text()).trim() : null;
}

/** A figure a run wrote, or nothing: the scripts writing these also write `unknown`. */
function count(text: string | null): number | null {
    const n = text === null ? Number.NaN : Number(text);

    return Number.isFinite(n) ? n : null;
}

/**
 * What each static analysis tool sends off the runner to do its job.
 *
 * Both are on by default and both reach the network. A maintainer reading a run should see
 * the egress in the run rather than have to go and find it.
 */
const EGRESS: ReadonlyMap<string, string> = new Map([
    ["semgrep", "fetched its ruleset from semgrep's registry"],
    ["osv-scanner", "sent the package names in each changed lockfile to osv.dev"],
]);

/** What the tool stage did, read back from the reports rather than from what was asked for. */
async function toolsRan(): Promise<{ names: string[]; egress: string[] }> {
    const names: string[] = [];
    const egress: string[] = [];

    for await (const file of new Bun.Glob("tool-*.json").scan({ cwd: dir })) {
        const parsed = record(await Bun.file(join(dir, file)).json().catch(() => null));
        const tool = typeof parsed?.tool === "string" ? parsed.tool : file.slice(5, -5);

        if (parsed?.ran !== true) {
            names.push(`${tool} (skipped)`);
            continue;
        }

        names.push(tool);

        const said = EGRESS.get(tool);
        if (said) egress.push(`${tool} ${said}`);
    }

    return { names: names.sort(), egress: egress.sort() };
}

const findings = (await value("findings-count")) ?? "none reported";
const cost = await value("cost-usd");
const tokens = count(await value("output-tokens"));
const durationMs = count(await value("duration-ms"));
const denials = count(await value("permission-denials")) ?? 0;
const tools = await toolsRan();

const rows: Array<[string, string]> = [
    ["Findings", findings],
    ["Cost", cost === null || cost === "unknown" ? "unknown" : `$${cost}`],
    ["Output tokens", tokens === null ? "unknown" : tokens.toLocaleString("en-GB")],
    ["Wall clock", durationMs === null ? "unknown" : `${(durationMs / 60000).toFixed(1)} min`],
];

if (tools.names.length > 0) rows.push(["Static analysis", tools.names.join(", ")]);

const table = `### CodeFerret\n\n| Measure | Value |\n|---|---|\n${rows
    .map(([measure, reading]) => `| ${measure} | ${reading} |`)
    .join("\n")}\n`;

const egress = tools.egress.length > 0 ? `\n> [!NOTE]\n> ${tools.egress.join(", and ")}.\n` : "";

const refused = denials === 1 ? "1 tool call was" : `${denials} tool calls were`;

const refusals =
    denials > 0
        ? `\n> [!WARNING]\n> ${refused} refused. The review covers less than this summary suggests.\n`
        : "";

const failed =
    exitStatus !== undefined && exitStatus !== "0"
        ? "\n> [!WARNING]\n> The review failed. Read the step log.\n"
        : "";

process.stdout.write(table + egress + refusals + failed);
