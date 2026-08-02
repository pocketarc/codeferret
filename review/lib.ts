/**
 * What more than one of a run's scripts depends on: how a thread of ours is recognised,
 * what the lenses were told to diff, and the two helpers every one of them uses on a value
 * a model produced. How those scripts talk to GitHub is in `review/github.ts`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value whose fields can be read, or null.
 *
 * Every script here reads JSON a model wrote, and this is the narrowing each one takes
 * before touching a field. `typeof null` is `"object"` and so is an array, and without this
 * a caller reads every field off either as `undefined` and carries on as though the shape
 * were right.
 */
export function record(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

/**
 * What went wrong, as a line a reader can act on.
 *
 * These scripts are written to fail soft, so a line like this is often the only sign that
 * anything went wrong. One function, so every caller words it the same way and none of them
 * loses the message from something thrown that is not an `Error`.
 */
export function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The two shapes an inline comment of ours was ever written in, which is how
 * fetch-existing.ts recognises a thread an earlier version left behind. Neither carries any
 * weight on its own, and `fetch-existing.ts` has why.
 *
 * Nothing writes either now: a review is one body and creates no threads at all. What is
 * left to recognise is what is still open on pull requests reviewed before this change.
 * `<sub>` is the released shape, from `@v1.0.0` and everything before it. The marker went
 * in later, alongside the italic category line, and only ever reached the runs made while
 * this branch was being built. Change either string and those threads become
 * unrecognisable, nothing is resolved, and nothing reports a problem.
 */
export const MARKER = "<!-- codeferret -->";

/** The category trailer every released inline comment ended with. */
export const RELEASED_TRAILER = /<sub>[^<]*<\/sub>\s*$/;

export interface DiffArgs {
    /** The commit range the lenses reviewed under. */
    range: string;
    /** The pathspec, `--` included, or empty when the run excluded nothing. */
    pathspec: string[];
}

/**
 * Read back the git arguments build-prompts.sh wrote for the lenses.
 *
 * Every consumer reads the file rather than building its own, because two constructions
 * of the range or the pathspec drift, and once they do a script is working from a diff no
 * lens read. The layout lives here so that adding an argument breaks one function instead
 * of three hand-rolled parses, two of which fail into a report saying the tool ran
 * cleanly.
 */
export async function readDiffArgs(argsFile: string): Promise<DiffArgs> {
    const file = Bun.file(argsFile);

    if (!(await file.exists())) throw new Error(`no ${argsFile}`);

    const [range, ...pathspec] = (await file.text()).split("\0").filter(Boolean);

    if (!range) throw new Error(`${argsFile} names no range`);

    return { range, pathspec };
}

/**
 * The commit the lenses reviewed, or null when the run reviewed the working tree instead.
 *
 * build-prompts.sh pins `HEAD` when a run starts, because a run takes tens of minutes and
 * whoever started it is usually still committing, so the range is the only place that
 * commit is written down.
 */
export function reviewedCommit(range: string): string | null {
    const at = range.lastIndexOf("...");

    return at === -1 ? null : range.slice(at + 3);
}
