#!/usr/bin/env bun
/**
 * What is settled once the session has exited: which build files a run will still read, and
 * whether the review it paid for is safe to post.
 *
 * Here rather than in run.sh, for the reason select-lenses.ts records: `bun test` covers no
 * shell, and both halves of this were shell with nothing exercising either.
 *
 * The `bun` invocations a finalise still runs, extract-findings.ts and check-findings.ts, stay
 * in run.sh. `checkBunConfig` reads shell and action.yml alone for the `--config=/dev/null` that
 * keeps the reviewed tree's `bunfig.toml` out of a job holding both tokens, so a spawn moved in
 * here would go unchecked.
 *
 * Usage:
 *   bun finalise.ts prepare <build-dir>
 *   bun finalise.ts settle <build-dir> <session-status> <extracted|-> <checked|->
 *
 * `prepare` runs between the session and those tools; `settle` runs after them, and exits with
 * the status the whole run ends on.
 */

import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RUN_FILES, RUN_MARKER } from "./run-files.ts";

/** Every run file extract-findings.ts writes. `findingsChecked` belongs to settle and is not one. */
type Reported = Exclude<(typeof RUN_FILES)[keyof typeof RUN_FILES], typeof RUN_FILES.findingsChecked>;

/**
 * What each of those files says about a run that never reported a number.
 *
 * The same values extract-findings.ts writes for a session with no result message in its log,
 * written here before it runs rather than only by it. They used to be written on that path
 * alone, so a run whose log the guard below removed left whatever was already on disk: the job
 * summary, the action's `cost-usd` and `findings-count` outputs and the artifact then carried
 * numbers with nothing behind them, and `permission-denials` is the file CLAUDE.md's lapse
 * condition for running the orchestrator under `bypassPermissions` is measured from.
 */
export const UNREPORTED: Record<Reported, string> = {
    [RUN_FILES.findingsCount]: "none reported",
    [RUN_FILES.cost]: "unknown",
    [RUN_FILES.outputTokens]: "unknown",
    [RUN_FILES.durationMs]: "unknown",
    [RUN_FILES.permissionDenials]: "unknown",
};

/**
 * Everything directly under the build directory that is not a plain file, removed.
 *
 * The orchestrator holds `Bash` under `bypassPermissions` and `--plugin-dir` is handed the
 * directory this one sits under, so every path here is a path a lens can reach. A symbolic
 * link left at one of them is followed by whatever reads it next: `emit_output_file` cats it
 * into `$GITHUB_OUTPUT`, `upload-artifact` follows it and publishes its target for 14 days, and
 * a `:` truncation writes through it rather than replacing it.
 *
 * The whole directory rather than a list of names, because a list is a thing to keep in step
 * and this one was not: it held `run.json` and `lens-list.txt` while every file the run's own
 * numbers live in went unguarded. The directory is flat by construction, since build-prompts.sh
 * and run.sh write files into it and nothing else, so anything that is not a plain file is
 * something the session left, and whoever adds the first subdirectory has to decide here what
 * happens to it.
 *
 * Removed rather than trusted. A missing run file reads as a run that reported no number, which
 * is what the values above are for, and a missing `lens-list.txt` costs a maintainer one file of
 * a review that still posts.
 *
 * The container is held to the same reasoning as the entries, and was not: `readdirSync`
 * follows a symbolic link at `dir` itself, so a session that replaced the build directory with
 * a link to a home directory had every subdirectory of it deleted here, as the user the job
 * runs as. So this refuses rather than sweeps unless `dir` is a real directory carrying the
 * marker build-prompts.sh wrote. Failing is the safe direction: `settle` already ends a run
 * with no extraction unpostable, where a sweep of the wrong tree cannot be undone.
 */
export function guardBuildDir(dir: string): string[] {
    const removed: string[] = [];
    const container = lstatSync(dir, { throwIfNoEntry: false });

    // `lstatSync`, so a link to a directory answers no here rather than being followed.
    if (container?.isDirectory() !== true) {
        throw new Error(`${dir} is not a directory this run can sweep, so nothing was removed from it.`);
    }

    const marker = lstatSync(join(dir, RUN_MARKER), { throwIfNoEntry: false });

    if (marker?.isFile() !== true) {
        throw new Error(`${dir} carries no ${RUN_MARKER}, so it is not the directory this run built.`);
    }

    for (const name of readdirSync(dir)) {
        const path = join(dir, name);

        // `throwIfNoEntry` rather than an `existsSync` ahead of it: the entry was listed a
        // moment ago by a process the session's own lenses outlive, and a stat that lost the
        // race would otherwise end the run in an exception over a file that is already gone.
        const found = lstatSync(path, { throwIfNoEntry: false });

        if (found?.isFile() === true) continue;

        rmSync(path, { recursive: true, force: true });
        removed.push(name);
    }

    return removed.sort();
}

/** How a run ends, and whether the review it produced may be posted. */
export interface Settled {
    /** The exit code the whole run takes. */
    status: number;
    /** Whether `findings-checked` goes down, which is the only thing the action posts on. */
    postable: boolean;
    /** What a reader of the step log is told, one line each. */
    reasons: string[];
}

/**
 * The status a run ends on, weighed from the session's own exit, the extraction's and the shape
 * check's.
 *
 * `extracted` and `checked` are null where that tool did not run, which for each of them means
 * the file it reads was not there. A null `extracted` is the case this table was written for: a
 * run whose log the guard above removed used to skip extraction, skip the shape check, write no
 * marker, and exit with whatever the session exited with. On a clean session that is 0, so a
 * tampered-with run ended green, posted nothing, and printed no failure warning in the job
 * summary. A maintainer saw a successful job beside an unreviewed pull request.
 *
 * Exit 3 from check-findings.ts means it dropped what it could not use and left a file worth
 * posting, so the marker goes down and the run still ends red.
 */
export function settle(session: number, extracted: number | null, checked: number | null): Settled {
    const reasons: string[] = [];
    let status = session;

    if (extracted === null) {
        reasons.push("there was no run log after the session, so nothing was extracted and nothing will be posted.");
        if (status === 0) status = 1;
    } else if (status === 0) {
        status = extracted;
    }

    // A findings file with no run log behind it is a file the session wrote. It is the one way
    // the shape check can pass on something no extraction produced, and the marker is what the
    // action posts on, so the reason printed above has to bind the marker as well as the status.
    const postable = extracted !== null && (checked === 0 || checked === 3);

    if (checked !== null && checked !== 0 && status === 0) status = 1;

    return { status, postable, reasons };
}

/** A tool's exit code as run.sh passes it, with `-` for a tool that did not run. */
function asExit(value: string | undefined): number | null | undefined {
    if (value === "-") return null;
    if (value !== undefined && /^\d+$/.test(value)) return Number(value);

    return undefined;
}

if (import.meta.main) {
    const [command, dir, ...rest] = process.argv.slice(2);

    if (!dir) {
        console.error("usage: bun finalise.ts prepare|settle <build-dir> ...");
        process.exit(2);
    }

    if (command === "prepare") {
        let swept: string[];

        // The refusal is a sentence, not a stack trace: the reader is whoever opens the step
        // log of a run that stopped, and what they need is the path and the reason.
        try {
            swept = guardBuildDir(dir);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }

        for (const name of swept) {
            console.error(
                `${join(dir, name)} was not a plain file after the session, so it was removed rather than trusted.`,
            );
        }

        // After the guard, so none of them is written through a link the session planted.
        for (const [file, value] of Object.entries(UNREPORTED)) {
            await Bun.write(join(dir, file), value);
        }

        process.exit(0);
    }

    if (command === "settle") {
        const [session, extracted, checked] = [asExit(rest[0]), asExit(rest[1]), asExit(rest[2])];

        if (session === undefined || session === null || extracted === undefined || checked === undefined) {
            console.error("usage: bun finalise.ts settle <build-dir> <session-status> <extracted|-> <checked|->");
            process.exit(2);
        }

        const outcome = settle(session, extracted, checked);

        for (const reason of outcome.reasons) console.error(reason);

        if (outcome.postable) {
            await Bun.write(join(dir, RUN_FILES.findingsChecked), "ok");
            console.log(`findings: ${join(dir, "findings.json")}`);
        }

        process.exit(outcome.status);
    }

    console.error(`finalise.ts takes prepare or settle, not '${command ?? ""}'.`);
    process.exit(2);
}
