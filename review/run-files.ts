/**
 * The names a run writes beside the findings file, and the single line format read back out
 * of them.
 *
 * Each is protocol between a script that writes it and a reader that never sees that script:
 * extract-findings.ts writes them, summary.ts reads them back off disk, and action.yml turns
 * some of them into step outputs. Every reader treats an absent file as `unknown`, which is
 * also what those scripts write for a session that died, so after a rename on one side the
 * summary reports a $36 review as `unknown`, which looks exactly like the failure these
 * files exist to make visible.
 *
 * `run_dirs` in lib.sh is the same fact one level up, and diff-args.ts is the same fact about
 * the range. validate-repo.ts checks action.yml's names against this set, because that file
 * cannot import it.
 */
import { join } from "node:path";
import { lines } from "./lines.ts";

export const RUN_FILES = {
    findingsCount: "findings-count",
    cost: "cost-usd",
    outputTokens: "output-tokens",
    durationMs: "duration-ms",
    permissionDenials: "permission-denials",
    /** The condition the action posts on. Written by finalise.ts, and only where the check passed. */
    findingsChecked: "findings-checked",
} as const;

/** Every name above, for a caller that has to see the set rather than one member. */
export const RUN_FILE_NAMES: readonly string[] = Object.values(RUN_FILES);

/** Every run file a run's numbers go in. `findingsChecked` is the marker and is not one. */
export type RunNumberFile = Exclude<(typeof RUN_FILES)[keyof typeof RUN_FILES], typeof RUN_FILES.findingsChecked>;

/**
 * What each of those files says about a run that never reported a number.
 *
 * finalise.ts writes these before the extraction runs, and extract-findings.ts writes them
 * again for a session with no result message in its log. They used to be written on the second
 * path alone, so a run whose log the sweep removed left whatever was already on disk: the job
 * summary, the action's `cost-usd` and `findings-count` outputs and the artifact then carried
 * numbers with nothing behind them, and `permission-denials` is the file CLAUDE.md's lapse
 * condition for running the orchestrator under `bypassPermissions` is measured from.
 *
 * Here rather than in either of them, because both write the same thing and the two used to
 * hold a copy each with nothing comparing them. To every reader an absent file is
 * indistinguishable from a zero, and `unknown` is what a killed session writes, so one path
 * saying `unknown` where the other says `not measured` is two answers to the same question with
 * every gate green.
 */
export const UNREPORTED: Record<RunNumberFile, string> = {
    [RUN_FILES.findingsCount]: "none reported",
    [RUN_FILES.cost]: "unknown",
    [RUN_FILES.outputTokens]: "unknown",
    [RUN_FILES.durationMs]: "unknown",
    [RUN_FILES.permissionDenials]: "unknown",
};

/**
 * What build-prompts.sh drops in the build directory to say it built it.
 *
 * That script refuses to delete a plugin directory that does not carry this file, because
 * /codeferret:review has a model paste the path in by hand. `guardBuildDir` makes the same
 * check one step later, for the same reason: it deletes recursively through the directory it is
 * handed, and by then a session has had a whole review to leave a symbolic link where the
 * directory was.
 */
export const RUN_MARKER = ".codeferret-run";

/**
 * Where build-prompts.sh writes the lenses it dispatched, one `<namespace>:<lens>` per line.
 *
 * A second file beside `lens-list.txt`, which holds the same names as markdown bullets for
 * the orchestrator's prompt. One file serving both meant a prompt fragment's decoration was
 * also a wire format two languages had to agree on, and drift was silent in the direction
 * that matters: a changed bullet leaves `dispatchedFrom` returning nothing, `coverageOf`
 * stops reporting a lens that ran and said nothing about itself, and check-findings.ts goes
 * on printing `shape valid`. Holding the two together took a check in validate-repo.ts that
 * read the `printf` format out of the shell and re-implemented printf to render it. Splitting
 * them costs one more `printf`, removes all of that, and leaves the prompt's wording free to
 * change again.
 */
export const DISPATCHED_FILE = "lenses.txt";

/** The lenses a run dispatched, out of that file's text. */
export function dispatchedFrom(text: string): string[] {
    return lines(text);
}

/**
 * Where run.sh writes the build files the session changed under it, one name per line.
 *
 * Empty is the ordinary answer and is written every run, so an absent file means the review is
 * being posted from a findings file somebody copied rather than that nothing moved. The
 * session cannot forge it: run.sh truncates it after the session has exited, and the digests
 * it decides from live in that shell's own variables.
 *
 * A name in it decides the commit every finding's line belongs to, or which lenses this run
 * says it dispatched, so a reader judging how much of the change was covered has to be told.
 */
export const SESSION_CHANGED_FILE = "session-changed.txt";

/** The build files the session changed, out of the run directory. */
export async function readSessionChanged(dir: string): Promise<string[]> {
    const file = Bun.file(join(dir, SESSION_CHANGED_FILE));

    return (await file.exists()) ? lines(await file.text()) : [];
}

/**
 * The lenses a run dispatched, out of the run directory.
 *
 * Empty where the file is not there, which is a review checked or posted by hand from a
 * findings file somebody copied. Nothing here fails on that: what the list buys is a report
 * of a lens that ran and said nothing about itself, and a run whose list is gone has nothing
 * to compare against either way.
 */
export async function readDispatched(dir: string): Promise<string[]> {
    const file = Bun.file(join(dir, DISPATCHED_FILE));

    return (await file.exists()) ? dispatchedFrom(await file.text()) : [];
}
