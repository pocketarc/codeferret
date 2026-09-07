/**
 * Fitting a rendered review into the length GitHub accepts.
 *
 * A budget, one elastic list that spends what the fixed sections leave, and the line saying what
 * the budget left out. Nothing here names a finding: `review-body.ts` decides what a review says
 * and hands over the items, how to render one, and how to word their absence.
 *
 * Every rule here has a failure mode nothing downstream would report. A budget that goes
 * negative drops the findings the body exists to carry, and a cut at a character offset lands
 * inside a `<details>`, a fenced block or a finding's own markup, where GitHub renders the
 * wreckage.
 */

import { closeOpenDetails, closeOpenFence } from "./markdown.ts";

/**
 * GitHub's limit on a review body is 65536 characters. The difference is headroom.
 *
 * Exported for body-budget.test.ts, which builds a body against the limit rather than
 * against a number typed out beside it, and for review-body.test.ts.
 */
export const MAX_BODY = 60000;

/** The joined body, and which of the items offered actually reached it. */
export interface Assembled<T> {
    body: string;
    /**
     * The items whose rendering went in.
     *
     * The set offered to the listing is not the set printed: an item too long for what is left
     * is skipped, and nothing outside `assemble` can tell which ones went. `post-review.ts`
     * logs this count as what the body carried, and a log line that contradicts the body it
     * describes is worse than no log line.
     */
    printed: T[];
}

/** A heading, a reason, and the items listed under it. The one section that can run long. */
export interface Listing<T> {
    heading: string;
    /** Why these items and not others. Empty when the section holds all of them. */
    lead: string;
    items: T[];
    /** One item as the page shows it. */
    render: (item: T) => string;
    /**
     * The line saying what did not fit, given how many went and what stayed.
     *
     * The caller's, because only the caller has the noun for these things and whatever else is
     * worth saying about the ones that stayed. A helper here that appended an `s` printed
     * "further lenss" on any run that overflowed.
     */
    omitted: (missing: number, kept: T[]) => string;
}

/**
 * Held back from a list's budget for the line saying what the budget left out.
 *
 * Wide enough for the longest of those lines, the findings listing's: a count, the clause saying
 * a dropped finding outranks a printed one, and the sentence naming where the rest were kept. A
 * fourth, longer sentence there eats the margin and nothing fails.
 */
const OMISSION_RESERVE = 300;

/**
 * Items rendered and kept while they fit, with the rest dropped whole.
 *
 * A dropped item costs only itself: an item too long for what is left is passed over and the
 * shorter ones after it are still admitted. The alternative is to stop at the first one that
 * does not fit, which would leave a reader a prefix of a list already ordered worst-first, and
 * costs more, because a single verbose critical would then empty the section under it.
 *
 * What that leaves is a page a reader cannot take at face value, so the caller's `omitted` line
 * is where a review says on the page when something dropped outranks something printed.
 */
function cutToFit<T>(
    items: T[],
    render: (item: T) => string,
    limit: number,
    separator: number,
): { kept: T[]; lines: string[] } {
    const kept: T[] = [];
    const lines: string[] = [];
    let used = 0;

    for (const item of items) {
        const text = render(item);

        if (used + text.length + separator > limit) continue;

        kept.push(item);
        lines.push(text);
        used += text.length + separator;
    }

    return { kept, lines };
}

/**
 * A list cut to a character budget, with the line saying what was left out already in it.
 *
 * The reserve is subtracted here rather than at each caller. Both callers had their own copy of
 * that subtraction, their own count of what was missing and their own omission line, so the two
 * sections of one review body could come to disagree about what the reserve covers or how an
 * omission is worded.
 */
function boundedList<T>(
    items: T[],
    render: (item: T) => string,
    limit: number,
    separator: number,
    omission: (missing: number, kept: T[]) => string,
): { kept: T[]; lines: string[] } {
    const initial = cutToFit(items, render, limit - OMISSION_RESERVE, separator);
    const kept = initial.kept;
    const lines = initial.lines;
    let used = lines.reduce((total, line) => total + line.length + separator, 0);
    let missing = items.length - kept.length;

    const omissionLine = (): string => {
        const text = omission(missing, kept);
        const full = `- _${text}_`;
        const available = limit - used - separator;
        if (full.length <= available) return full;
        if (available < 5) return "";

        const innerLimit = available - 4;
        const inner = text.length <= innerLimit ? text : `${text.slice(0, innerLimit - 1)}…`;

        return `- _${inner}_`;
    };

    let line = missing === 0 ? "" : omissionLine();
    while (missing > 0 && line === "" && kept.length > 0) {
        kept.pop();
        used -= (lines.pop() ?? "").length + separator;
        missing = items.length - kept.length;
        line = omissionLine();
    }

    return { kept, lines: missing === 0 || line === "" ? lines : [...lines, line] };
}

/** A list of rendered lines from the head or the tail, cut to a character budget. */
export function boundedBlock(items: string[], limit: number, omitted: (n: number) => string): string {
    const say = (missing: number): string => `${omitted(missing)} left out for length.`;

    return boundedList(items, (item) => item, limit, 1, say).lines.join("\n");
}

/**
 * Join the review into one body no longer than GitHub accepts.
 *
 * Everything but the listing is short, and it is the part that makes the review honest: the
 * counts, the lens health, what was suppressed, and the caveats saying what the run could
 * not check. So the listing gets whatever length the rest leaves, and it loses whole
 * items rather than being cut at a character offset.
 *
 * What goes is not the tail of the list. `cutToFit` has why.
 */
export function assemble<T>(head: string[], listing: Listing<T> | null, tail: string[]): Assembled<T> {
    let budget = MAX_BODY - [...head, ...tail].reduce((total, s) => total + s.length + 2, 0);

    const rendered = [...head];
    let printed: T[] = [];

    if (listing) {
        const heading = listing.lead ? `### ${listing.heading}\n\n${listing.lead}` : `### ${listing.heading}`;
        budget -= heading.length + 2;

        const { kept, lines } = boundedList(listing.items, listing.render, budget, 2, listing.omitted);

        printed = kept;
        rendered.push([heading, ...lines].join("\n\n"));
    }

    rendered.push(...tail);

    const body = rendered.join("\n\n");

    return { body: body.length > MAX_BODY ? fit(body) : body, printed };
}

/**
 * The last-resort cut, reached only when the short sections alone exceed the limit, which
 * takes a `lens_health` list or a suppressed list of a size nothing here has seen.
 *
 * Both closers run before the notice. This cut lands anywhere, including inside one of the
 * `<details>` blocks above, and a browser closes that block at the end of the comment: the
 * reader would get a review that appears to stop, with the notice saying it was cut sealed
 * inside a collapsed disclosure.
 *
 * It never lands inside a finding, and that is what makes `closeOpenFence` sound here.
 * `assemble` reaches this only with the budget already negative, which is to say with no
 * bullet rendered. A bullet's body is indented two columns into the list item, so a fence at
 * its own indent 2 sits at absolute 4: still a fence to a renderer measuring from the item's
 * content column, and an indented code block to the absolute bound `fenceMap` applies.
 * Cutting inside one of those would leave a block neither closer can see.
 *
 * The reserve is for the closers, and overrunning it costs nothing: `MAX_BODY` already sits
 * under GitHub's limit.
 *
 * The cut lands on a line boundary because `details` writes its markup one element to a line,
 * and a character offset lands inside the `<summary>`: the reader got a disclosure control
 * labelled with a word fragment, or, two characters earlier, one whose `<summ` GitHub's
 * sanitiser drops, leaving the browser's own "Details" triangle over nothing.
 * `closeOpenDetails` counts `<details>` against `</details>` and repairs neither.
 */
function fit(body: string): string {
    const notice = "\n\n_(this review was cut for length)_";
    const limit = MAX_BODY - notice.length - 200;
    const boundary = body.lastIndexOf("\n", limit);
    const kept = dropEmptyDetails(body.slice(0, boundary > 0 ? boundary : limit));

    return `${closeOpenDetails(closeOpenFence(kept))}${notice}`;
}

/**
 * A trailing disclosure the cut left with nothing under it.
 *
 * On a line boundary the summary is whole or absent, so what is left of a half-cut block is
 * an opening tag and at most its label. `closeOpenDetails` would close it into a control that
 * opens onto nothing, at the foot of the review, where a reader takes it for content somebody
 * hid.
 */
function dropEmptyDetails(body: string): string {
    return body.replace(/\n?<details(?: open)?>(?:\n<summary>[^\n]*<\/summary>)?\s*$/, "");
}
