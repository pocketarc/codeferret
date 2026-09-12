#!/usr/bin/env bun
/**
 * Render the GitHub Actions job summary from the numbers a run wrote.
 *
 * Every value is read back off disk, so a run that died partway still reports whatever it
 * managed to write.
 *
 * Usage: bun summary.ts <build-dir> [<exit-status>]
 */

import { join } from "node:path";
import { RUN_FILES } from "./run-files.ts";

const [buildDir, exitStatus] = process.argv.slice(2);

if (!buildDir) {
    console.error("usage: bun summary.ts <build-dir> [<exit-status>]");
    process.exit(2);
}

const dir: string = buildDir;

/**
 * One of the numbers a run wrote, or nothing.
 *
 * An empty read counts as nothing, not as an empty string. Every reader treats an absent file
 * as `unknown` (`run-files.ts`), and a killed or out-of-disk run leaves the file there and
 * empty: `??` does not catch `""`, so Cost rendered as a bare `$`, Findings as a blank cell,
 * and `count` turned `Number("")` into a 0 that reads as a measurement.
 */
async function value(name: string): Promise<string | null> {
    const file = Bun.file(join(dir, name));

    if (!(await file.exists())) return null;

    const text = (await file.text()).trim();

    return text === "" ? null : text;
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

const findings = (await value(RUN_FILES.findingsCount)) ?? "none reported";
const cost = await value(RUN_FILES.cost);
const tokens = count(await value(RUN_FILES.outputTokens));
const durationMs = count(await value(RUN_FILES.durationMs));

// Left as the `null` a log with no `permission_denials` list produces, rather than folded
// into 0: extract-findings.ts writes `unknown` for that reason, because a log with no list at
// all is not evidence that nothing was refused, and collapsing it to 0 here would print the
// one figure that reason exists to keep apart from a clean run as though it were one.
const denials = count(await value(RUN_FILES.permissionDenials));

const rows: Array<[string, string]> = [
    ["Findings", findings],
    ["Cost", cost === null || cost === "unknown" ? "unknown" : `$${cost}`],
    ["Output tokens", tokens === null ? "unknown" : tokens.toLocaleString("en-GB")],
    ["Wall clock", durationMs === null ? "unknown" : wallClock(durationMs)],
    ["Refusals", denials === null ? "unknown" : String(denials)],
];

const table = `### CodeFerret\n\n| Measure | Value |\n|---|---|\n${rows
    .map(([measure, reading]) => `| ${measure} | ${reading} |`)
    .join("\n")}\n`;

/**
 * What the summary says about refused tool calls, or nothing where none were.
 *
 * The count is inflected inside the branch that has one. Built above the branches, it
 * rendered "null tool calls were" for a log carrying no `permission_denials` list, and was
 * correct only because a ternary written elsewhere reached the null case first. Formatting ahead
 * of that check has already cost this file twice: the `$` on the cost row, and the blank cell
 * `value` now answers null for.
 */
function refusals(denials: number | null): string {
    if (denials === null) {
        return (
            "\n> [!WARNING]\n> Whether any tool call was refused could not be read from this run's log." +
            " The review may cover less than this summary suggests.\n"
        );
    }

    // `count` reads whatever number the file holds, so the test is for a positive one rather
    // than for zero: a run that wrote `-1` would otherwise report that refusal on the page.
    if (denials <= 0) return "";

    const refused = denials === 1 ? "1 tool call was" : `${denials} tool calls were`;

    return `\n> [!WARNING]\n> ${refused} refused. The review covers less than this summary suggests.\n`;
}

const failed =
    exitStatus !== undefined && exitStatus !== "0"
        ? "\n> [!WARNING]\n> The review failed. Read the step log.\n"
        : "";

process.stdout.write(table + refusals(denials) + failed);
