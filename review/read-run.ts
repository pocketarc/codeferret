/**
 * The files a posted review and a printed one both read, and the one answer each gets.
 *
 * The IO for `findings.ts`, which stays pure.
 */

import { join } from "node:path";
import type { RunFacts } from "./caveats.ts";
import { readExisting, survey, unreadOf } from "./existing.ts";
import type { Survey, Surveyed } from "./existing.ts";
import type { Finding, Merged, Tier, Vetted } from "./findings.ts";
import { isMerged, vetSuppression } from "./findings.ts";
import { reason } from "./json.ts";
import { filesRaisedBefore } from "./previous.ts";
import { readDispatched, readSessionChanged } from "./run-files.ts";

/** What a reader is told, so a caller decides where a line goes. */
export type Report = (line: string) => void;

/**
 * The lowest tier the review body prints in full, and the bar a suppression of one is held to.
 *
 * This is provisional. The bands in `review/risk.ts` are a starting point that no run has been
 * scored against yet, so this is a guess at where the line falls rather than a measurement of
 * it. It becomes the `print-threshold` action input once a scored run shows where to start it.
 */
export const REVIEW_THRESHOLD: Tier = "medium";

/**
 * A run's findings file, or the process ends naming the file and what was wrong with it.
 *
 * Nothing has necessarily validated the file. The action runs check-findings.ts first, but
 * local-post.sh and the by-hand path in review/README.md both come straight to a reader, and
 * an unhandled rejection at the end of a run that cost real money is a worse answer than a
 * sentence naming the file.
 *
 * The exit stays here rather than moving to post-review.ts and print-findings.ts, which is the
 * point of the function being shared: an unreadable findings file is one fact, and a posted
 * review and a printed one answering it differently is what this exists to prevent. `hint` is
 * the extra line a caller adds, naming the check that would explain it.
 */
export async function readMerged(path: string, report: Report, hint?: string): Promise<Merged> {
    const stop = (message: string): never => {
        report(`${path}: ${message}`);
        if (hint) report(hint);
        process.exit(1);
    };

    let parsed: unknown;

    try {
        parsed = JSON.parse(await Bun.file(path).text());
    } catch (error) {
        return stop(reason(error));
    }

    if (!isMerged(parsed)) return stop("has no `findings` array");

    return parsed;
}

export interface Vetting extends Vetted {
    /** What the vetting was decided against, which post-review.ts also reads its threads from. */
    existing: Surveyed;
    /** The one walk over it, which the review body reads its linkable urls from. */
    survey: Survey;
}

/** The previous run's findings, or `{}` with a line saying they could not be read. */
async function readPrevious(path: string, report: Report): Promise<unknown> {
    const file = Bun.file(path);

    if (!(await file.exists())) return {};

    try {
        return JSON.parse(await file.text());
    } catch {
        report("previous.json could not be read, so a finding said to have been raised before is raised again.");
        return {};
    }
}

/**
 * Vet a run's suppressions against the discussion on the pull request and against what the
 * last review said.
 *
 * Shared for the reason `readMerged` is: a session and a posted review must not vet the same
 * findings against different files.
 *
 * Neither file is the copy the orchestrator was handed. The orchestrator held both paths in
 * the same prompt as the rules applied here, so it could have written the evidence its own
 * suppressions are checked against. `run.sh` replaces both with their empty forms once the
 * session has exited, and the paths that hold a credential of their own fetch them again: the
 * action's posting step for both, and `local-post.sh` and `local-print.sh` for
 * `existing.json`. An empty file reopens every suppression resting on it, which is the
 * direction to fail in.
 */
export async function vetAgainstExisting(
    findings: Finding[],
    buildDir: string,
    report: Report,
    threshold: Tier,
): Promise<Vetting> {
    const existing = await readExisting(buildDir, report);
    const raisedBefore = filesRaisedBefore(await readPrevious(join(buildDir, "previous.json"), report));
    const walked = survey(existing);

    return { existing, survey: walked, ...vetSuppression(findings, walked, raisedBefore, threshold) };
}

/**
 * What `coverageOf` needs beyond a run's own findings, read off the build directory and the
 * vetting already done against it.
 *
 * Shared for the reason the rest of this module is: `post-review.ts` and `print-findings.ts`
 * built this bag of three reads independently, from the same directory and the same vetting
 * result, so a caller that named the wrong directory or read `unread` from a different
 * `Surveyed` compiled anyway. One function here is the one place a fourth read would join it.
 */
export async function runFacts(buildDir: string, existing: Surveyed): Promise<RunFacts> {
    return {
        unread: unreadOf(existing),
        dispatched: await readDispatched(buildDir),
        sessionChanged: await readSessionChanged(buildDir),
    };
}
