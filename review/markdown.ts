/**
 * Where a fenced code block starts and stops.
 *
 * Two things here read markdown and must not touch what is inside a fence: the review body
 * escapes prose a model wrote, and `scripts/rewrite-markdown.ts` rewrites a vendored
 * skill and can delete a line.
 */

const FENCE = /^\s*(```+|~~~+)/;

/**
 * Whether each line falls inside a fenced code block, the opening and closing lines
 * included. A caller that maps over the false lines therefore leaves a delimiter alone.
 */
export function fenceMap(lines: string[]): boolean[] {
    const inside: boolean[] = [];
    let open: string | null = null;

    for (const line of lines) {
        const fence = line.match(FENCE)?.[1];

        if (open === null && fence) {
            open = fence[0] === "`" ? "`" : "~";
            inside.push(true);
            continue;
        }

        if (open !== null && fence && fence[0] === open) {
            open = null;
            inside.push(true);
            continue;
        }

        inside.push(open !== null);
    }

    return inside;
}

/** Close a fence the text left open, so what follows it does not render as code. */
export function closeOpenFence(text: string): string {
    const lines = text.split("\n");
    let open: string | null = null;

    for (const line of lines) {
        const fence = line.match(FENCE)?.[1];
        if (!fence) continue;
        if (open === null) open = fence;
        else if (fence[0] === open[0]) open = null;
    }

    return open === null ? text : `${text}\n${open}`;
}
