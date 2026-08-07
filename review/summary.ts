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
import { RUN_FILES } from "./run-files.ts";
import { TOOL_REPORT_GLOB, toolFromReportName } from "./tools/report.ts";

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
 * How long the run took, in a readable unit.
 *
 * Tenths of a minute is unreadable at the short end, and the short end is where a maintainer
 * is looking hardest: a session that died in the first seconds renders as `0.0 min` beside
 * the warning saying the review failed.
 */
function wallClock(durationMs: number): string {
    return durationMs < 60_000 ? `${Math.round(durationMs / 1000)} s` : `${(durationMs / 60000).toFixed(1)} min`;
}

/**
 * What the tool stage did, read back from the reports rather than from what was asked for.
 *
 * The egress line is each tool's own `egress` field, written by the invocation that made the
 * request. A maintainer reading a run should see what left the runner without going to find
 * it, and a table here keyed by tool name would make the same claim for a run that sent
 * nothing.
 */
async function toolsRan(): Promise<{ names: string[]; egress: string[] }> {
    const names: string[] = [];
    const egress: string[] = [];

    for await (const file of new Bun.Glob(TOOL_REPORT_GLOB).scan({ cwd: dir })) {
        const parsed = record(await Bun.file(join(dir, file)).json().catch(() => null));
        const tool = typeof parsed?.tool === "string" ? parsed.tool : toolFromReportName(file);

        if (parsed?.ran !== true) {
            names.push(`${tool} (skipped)`);
            continue;
        }

        names.push(tool);

        if (typeof parsed.egress === "string" && parsed.egress !== "") egress.push(`${tool} ${parsed.egress}`);
    }

    return { names: names.sort(), egress: egress.sort() };
}

const findings = (await value(RUN_FILES.findingsCount)) ?? "none reported";
const cost = await value(RUN_FILES.cost);
const tokens = count(await value(RUN_FILES.outputTokens));
const durationMs = count(await value(RUN_FILES.durationMs));
const denials = count(await value(RUN_FILES.permissionDenials)) ?? 0;
const tools = await toolsRan();

const rows: Array<[string, string]> = [
    ["Findings", findings],
    ["Cost", cost === null || cost === "unknown" ? "unknown" : `$${cost}`],
    ["Output tokens", tokens === null ? "unknown" : tokens.toLocaleString("en-GB")],
    ["Wall clock", durationMs === null ? "unknown" : wallClock(durationMs)],
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
