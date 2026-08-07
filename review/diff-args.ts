/**
 * What the lenses were told to diff, read back out of the file build-prompts.sh wrote.
 *
 * Every consumer reads that file rather than building its own range or pathspec, because
 * two constructions drift, and once they do a script is working from a diff no lens read.
 * The layout lives here so that adding an argument breaks one function rather than a
 * hand-rolled parse in each consumer, where the failure is a report saying the tool ran
 * cleanly.
 */

export interface DiffArgs {
    /** The commit range the lenses reviewed under. */
    range: string;
    /** The pathspec, `--` included, or empty when the run excluded nothing. */
    pathspec: string[];
}

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
