/**
 * The two things a run's scripts have to agree on across process boundaries.
 *
 * Each was written out twice before, once at each end, and neither end could tell when
 * the other had moved.
 */

/**
 * Stamped into every inline comment by post-review.ts and required by fetch-existing.ts
 * before it will call a thread the run's own.
 *
 * A wire protocol between two processes: change it at one end only and no thread is ever
 * recognised again, nothing is resolved, and nothing reports a problem.
 */
export const MARKER = "<!-- codeferret -->";

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
