/**
 * Where a fenced code block starts and stops.
 *
 * Two things here read markdown and must not touch what is inside a fence: the review body
 * escapes prose a model wrote, and `scripts/rewrite-markdown.ts` rewrites a vendored
 * skill and can delete a line.
 */

const FENCE = /^\s*(```+|~~~+)/;

/**
 * Whether a run of delimiters closes a block the given run opened.
 *
 * The length is what lets one code block nest inside another: a four-backtick fence around
 * three-backtick samples. Read as a single character, the inner ``` closes the outer ````,
 * and every line after it is read as prose.
 */
function closes(fence: string, open: string): boolean {
    return fence[0] === open[0] && fence.length >= open.length;
}

/**
 * One walk over the lines, so the two answers below cannot disagree about where a block
 * starts and stops. Written separately, one normalised the delimiter to a character and the
 * other kept the run, so a block opened with ```` and closed with ``` was closed for one
 * and still open for the other, which appended a fourth fence to text that needed none.
 */
function scan(lines: string[]): { inside: boolean[]; open: string | null } {
    const inside: boolean[] = [];
    let open: string | null = null;

    for (const line of lines) {
        const fence = line.match(FENCE)?.[1];

        if (fence && open === null) {
            open = fence;
            inside.push(true);
            continue;
        }

        if (fence && open !== null && closes(fence, open)) {
            open = null;
            inside.push(true);
            continue;
        }

        inside.push(open !== null);
    }

    return { inside, open };
}

/**
 * Whether each line falls inside a fenced code block, the opening and closing lines
 * included. A caller that maps over the false lines therefore leaves a delimiter alone.
 */
export function fenceMap(lines: string[]): boolean[] {
    return scan(lines).inside;
}

/** Close a fence the text left open, so what follows it does not render as code. */
export function closeOpenFence(text: string): string {
    const { open } = scan(text.split("\n"));

    return open === null ? text : `${text}\n${open}`;
}
