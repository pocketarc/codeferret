/**
 * Reading and neutralising markdown a model wrote.
 *
 * Two things here need to know where a fenced block starts and stops, and must not touch
 * what is inside one: the review body escapes prose a model wrote, and
 * `scripts/rewrite-markdown.ts` rewrites a vendored skill and can delete a line.
 *
 * The escaping below is the whole policy for what a model's prose may open in a posted
 * review. It lives in one module because the two halves (what a character does mid-line,
 * and what it does at the start of one) were written apart and disagreed about `<`, and a
 * review body is where the disagreement showed.
 */

const FENCE = /^\s*(```+|~~~+)(.*)$/;

/**
 * Whether a run of delimiters closes a block the given run opened.
 *
 * The length is what lets one code block nest inside another: a four-backtick fence around
 * three-backtick samples. Read as a single character, the inner ``` closes the outer ````,
 * and every line after it is read as prose.
 *
 * The info string is the other half of that. CommonMark lets only an opening fence carry
 * one, so ```` ```sql ```` can never close a block. Without the rule a nested ```` ```sql ````
 * sample ends its parent block of the same length, and every line inside it comes back as
 * prose the rewriter may edit or delete. That is live in two vendored skills.
 */
function closes(fence: string, info: string, open: string): boolean {
    return fence[0] === open[0] && fence.length >= open.length && info.trim() === "";
}

/**
 * One walk over the lines, so the two answers below cannot disagree about where a block
 * starts and stops.
 */
function scan(lines: string[]): { inside: boolean[]; open: string | null } {
    const inside: boolean[] = [];
    let open: string | null = null;

    for (const line of lines) {
        const match = line.match(FENCE);
        const fence = match?.[1];
        const info = match?.[2] ?? "";

        if (fence && open === null) {
            open = fence;
            inside.push(true);
            continue;
        }

        if (fence && open !== null && closes(fence, info, open)) {
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

/**
 * Close every `<details>` the text left open, so what follows sits outside the block.
 *
 * The counterpart to `closeOpenFence`, and it exists for the review body's last-resort cut:
 * a browser closes an unclosed `<details>` at the end of the comment, hiding everything
 * after the cut inside a collapsed disclosure. `fit` in review-body.ts has the rest.
 *
 * Counted over the same view of the text the renderer sees, which means line by line: a
 * fenced line is a code sample and a `\<` is prose that came through `escapeTags`, and
 * neither opens a disclosure. Prose and samples about markup are what these lenses write,
 * so counting the raw string appends a stray closer to an ordinary review.
 */
export function closeOpenDetails(text: string): string {
    const lines = text.split("\n");
    const fenced = fenceMap(lines);
    let open = 0;

    for (const [i, line] of lines.entries()) {
        if (fenced[i]) continue;

        open += (line.match(/(?<!\\)<details\b/g) ?? []).length;
        open -= (line.match(/(?<!\\)<\/details>/g) ?? []).length;
    }

    if (open <= 0) return text;

    return `${text}\n${Array.from({ length: open }, () => "</details>").join("\n")}`;
}

/**
 * Escape a set of characters wherever they fall outside a code span.
 *
 * Text inside a code span is left alone, because the orchestrator writes code spans
 * deliberately and a backslash inside one lands on the page.
 *
 * The backslash is escaped first, and before anything else in the set, because one already
 * in the text cancels the escape put after it: `a\*b` would become `a\\*b`, a literal
 * backslash followed by a live asterisk. Text ending in one is worse, since `bullet` wraps
 * a title in `**`, and the trailing backslash then escapes the first closing asterisk and
 * the emphasis runs on into the body. Windows paths, regexes and LaTeX fragments all reach
 * a title.
 */
function escapeOutsideCode(text: string, set: string): string {
    let out = "";
    let i = 0;

    while (i < text.length) {
        const char = text[i] ?? "";

        if (char === "`") {
            let run = 0;
            while (text[i + run] === "`") run += 1;

            const fence = "`".repeat(run);
            const close = text.indexOf(fence, i + run);

            if (close !== -1) {
                out += text.slice(i, close + run);
                i = close + run;
                continue;
            }

            // Nothing closes it, so this opens no code span. Left alone it pairs with the
            // next backtick markdown finds, usually one in the finding's own body, and
            // renders everything between the two as code.
            out += "\\`".repeat(run);
            i += run;
            continue;
        }

        out += set.includes(char) ? `\\${char}` : char;
        i += 1;
    }

    return out;
}

/**
 * Escape the markdown a model did not mean to write, leaving the markdown it did.
 *
 * For a field that renders as part of a line: a title, a category, a lens's one-line
 * caveat. A title naming a glob is the case that bites: a doubled asterisk opens strong
 * emphasis, so a bare `build` exclusion glob renders as emphasis debris rather than as a
 * path.
 *
 * `@` is in the set because a review quotes identifiers back out of a diff, and GitHub
 * turns `@types/bun`, a `@param` line or a CODEOWNERS entry into a mention that notifies
 * whoever owns that name, from the account that posts the review, on every push. Anyone who
 * wants that only has to put a handle where a lens will quote it. GitHub renders `\@name`
 * as the text it is.
 */
export function escapeInline(text: string): string {
    return escapeOutsideCode(text, "\\*_[]<~@");
}

/**
 * Escape the raw HTML and the mentions in a line of a model's prose, leaving its markdown
 * alone.
 *
 * For a block of prose, where emphasis and links are the model's own and worth keeping but
 * a tag is not. GitHub renders `<details>` and `<div>` wherever they sit on a line, not
 * only at column zero, and one left unclosed hides everything after it: the suppressed
 * list, the declined list and the caveats included, which are where a reader learns how
 * much of the review to trust. Prose about markup is exactly what these lenses write.
 *
 * `@` for the reason `escapeInline` takes it: a finding body quoting a scoped package name
 * would otherwise notify an account on every push.
 */
function escapeTags(text: string): string {
    return escapeOutsideCode(text, "\\<@");
}

/**
 * Escape the block a line would otherwise open on its own.
 *
 * The review's own headings are an h2 and h3s below it, so a model's line opening with `#`
 * emits an h1 into the middle of the body, and heading level is what a screen reader
 * navigates by. `>` at the start of a line inside a list item opens a blockquote. A line
 * that is nothing but a run of `-`, `=`, `*` or `_` is a thematic break, and one directly
 * under a line of prose turns that prose into a heading instead.
 */
export function escapeBlockStart(line: string): string {
    const escaped = line.replace(/^(\s*)([#>])/, "$1\\$2");

    return /^\s*(=+|-+|\*{3,}|_{3,})\s*$/.test(escaped) ? escaped.replace(/^(\s*)(.)/, "$1\\$2") : escaped;
}

/**
 * A model's block of prose, with everything it would open on its own escaped and everything
 * inside a fence left alone.
 */
export function escapeBlocks(lines: string[]): string[] {
    const fenced = fenceMap(lines);

    return lines.map((line, i) => (fenced[i] ? line : escapeBlockStart(escapeTags(line))));
}

/**
 * A model's one-line field on one line.
 *
 * A field asked for as one line is not checked to be one. A newline inside a list item ends
 * the item, so the rest of a suppressed or declined list renders outside the `<details>`
 * block it belongs to, and inside `bullet` the same newline closes the strong emphasis and
 * leaves a literal `**` on the page.
 */
export function flatten(text: string): string {
    return text.replace(/\s*\n+\s*/g, " ").trim();
}

/**
 * A path inside a code span, with a delimiter long enough to hold it.
 *
 * A backtick is legal in a POSIX filename, and a one-backtick span closes at the first
 * backtick inside it, so the rest of the bullet renders as prose and the leftover delimiter
 * pairs with the next backtick in the review.
 */
export function code(text: string): string {
    const flat = flatten(text);

    let longest = 0;
    for (const run of flat.match(/`+/g) ?? []) longest = Math.max(longest, run.length);

    const fence = "`".repeat(longest + 1);
    // A span whose content starts or ends with a backtick needs a space, which markdown
    // then strips back off.
    const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";

    return `${fence}${pad}${flat}${pad}${fence}`;
}

/**
 * A link target, or null when the string is not one.
 *
 * The url arrives from a model and survives a round trip through the previous run's
 * artifact. A space or a `)` in it ends the link target early and spills the rest of the
 * line into the body, so a url that does not parse becomes no link rather than a broken
 * one. The brackets are encoded because `URL` leaves them alone and markdown does not.
 */
export function linkTarget(url: string | undefined): string | null {
    if (!url) return null;

    try {
        const parsed = new URL(url);

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

        return parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
    } catch {
        return null;
    }
}

/**
 * Text a model wrote, cut to a length the rest of the page can fit around.
 *
 * Cut on the largest boundary inside the window and close whatever fence the cut left open.
 * A cut at a character offset lands mid-span or mid-fence, and an unbalanced fence renders
 * everything below it as one code block. The paragraph is not always there to cut on: a
 * lens's list of what it could not check is often one paragraph or a run of single-newline
 * lines, and that is the field where a cut mid-word does the most damage.
 */
export function clamp(text: string, limit: number): string {
    if (text.length <= limit) return text;

    const window = text.slice(0, limit);
    const cut = (kept: string): string => `${closeOpenFence(kept)}\n\n_(cut for length)_`;

    const paragraph = window.lastIndexOf("\n\n");
    if (paragraph > 0) return cut(window.slice(0, paragraph));

    // The full stop is kept; the space after it is what the index names.
    const sentence = window.lastIndexOf(". ");
    if (sentence > 0) return cut(window.slice(0, sentence + 1));

    const word = window.lastIndexOf(" ");
    if (word > 0) return cut(window.slice(0, word));

    return cut(window);
}

/** Prose a model wrote, cut to length, with the blocks and tags it would open escaped. */
export function prose(text: string, limit: number): string {
    return escapeBlocks(clamp(text, limit).split("\n")).join("\n");
}

/**
 * A collapsed block. GitHub renders nothing at all if the markup is a line out.
 *
 * The summary is escaped here. Every caller today builds one out of counts, but nothing in
 * the signature says so, and an unbalanced tag in a `<summary>` swallows the rest of the
 * disclosure with no sign of it in the review. The body is the caller's to escape, because
 * each one is a different shape of model prose.
 */
export function details(summary: string, body: string, open = false): string {
    const heading = escapeInline(flatten(summary));

    return `<details${open ? " open" : ""}>\n<summary>${heading}</summary>\n\n${body}\n</details>`;
}
