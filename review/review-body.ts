/**
 * The anchoring and rendering a posted review is built from.
 *
 * Separated from post-review.ts so that `bun test` can reach it. Every function here is
 * pure over strings and JSON, and each one has a failure mode nothing downstream would
 * report: an off-by-one in the hunk walk anchors every comment a line out, and a budget
 * that goes negative drops the findings the body exists to carry.
 */

export interface Finding {
    found_by?: string[];
    file: string;
    line: number;
    end_line?: number;
    severity: string;
    category: string;
    title: string;
    body: string;
    in_diff?: boolean;
    status?: "new" | "already-reported" | "declined";
    existing_comment_url?: string;
}

export interface LensHealth {
    lens: string;
    findings_returned: number;
    ok: boolean;
    detail?: string;
}

export interface Merged {
    summary?: string;
    notes?: string;
    lens_health?: LensHealth[];
    resolve?: Array<{ thread_id: string; reason: string }>;
    findings: Finding[];
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "nit", "question"];

export const MAX_BODY = 60000;
export const MAX_INLINE = 40;

// The orchestrator writes both the summary and the notes, and nothing bounds what a model
// produces. Left unbounded, a runaway summary eats the length the findings need.
export const MAX_PROSE = 4000;

export function severityRank(s: string): number {
    const i = SEVERITY_ORDER.indexOf(s);
    return i === -1 ? SEVERITY_ORDER.length : i;
}

export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const FENCE = /^\s*(```+|~~~+)/;

/** Whether a line index falls inside a fenced code block. */
function fenceMap(lines: string[]): boolean[] {
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

/** Close a fence the cut left open, so the rest of the body does not render as code. */
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

/**
 * Escape the markdown a model did not mean to write, leaving the markdown it did.
 *
 * A title naming a glob is the case that bites: a doubled asterisk opens strong emphasis,
 * so a bare `build` exclusion glob renders as emphasis debris rather than as a path. Text
 * inside a code span is left alone, because the orchestrator writes code spans
 * deliberately and escaping inside one puts backslashes on the page.
 */
export function escapeInline(text: string): string {
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
        }

        out += "*_[]<".includes(char) ? `\\${char}` : char;
        i += 1;
    }

    return out;
}

/**
 * One finding as a bullet, for the sections of the body that list findings rather than
 * anchor them.
 *
 * The continuation indent is two spaces. Four after a blank line is an indented code
 * block in markdown, which takes the formatting out of the body and stops it wrapping.
 * Two spaces still sit inside the list item's content column, so a body line opening with
 * `#` is an ATX heading, and one finding can emit an h1 into a review whose own title is
 * an h2.
 */
export function bullet(f: Finding): string {
    const lines = f.body.split("\n");
    const fenced = fenceMap(lines);

    const body = lines
        .map((line, i) => (fenced[i] ? line : line.replace(/^(\s*)#/, "$1\\#")))
        .join("\n  ");

    return `- **${escapeInline(f.title)}**\n\n  \`${where(f)}\`\n\n  ${body}\n\n  _${f.category}_`;
}

/**
 * Where a finding sits, for a reader.
 *
 * A finding with no usable line reaches the body rather than a comment, so the path alone
 * is what there is to say. Interpolating the number regardless printed the word
 * "undefined" beside the file.
 */
export function where(f: Finding): string {
    if (!Number.isInteger(f.line)) return f.file;
    if (f.end_line && f.end_line !== f.line) return `${f.file}:${f.line}-${f.end_line}`;
    return `${f.file}:${f.line}`;
}

/** One finding as a single line, for the sections that only say a finding was seen. */
export function mention(f: Finding, link: string): string {
    const url = f.existing_comment_url ? ` ([${link}](${f.existing_comment_url}))` : "";
    return `- ${escapeInline(f.title)} (\`${where(f)}\`)${url}`;
}

/**
 * Prose the orchestrator wrote, cut to a length the findings can still fit around.
 *
 * Cut on a paragraph boundary and close whatever fence the cut left open. A cut at a
 * character offset lands mid-span or mid-fence, and an unbalanced fence renders the
 * counts, the lens health and every listed finding below it as one code block.
 */
export function clamp(prose: string, limit = MAX_PROSE): string {
    if (prose.length <= limit) return prose;

    const window = prose.slice(0, limit);
    const boundary = window.lastIndexOf("\n\n");

    return `${closeOpenFence(boundary > 0 ? window.slice(0, boundary) : window)}\n\n_(cut for length)_`;
}

/** A collapsed block. Written by hand in four places once, and GitHub is unforgiving about the markup. */
export function details(summary: string, body: string, open = false): string {
    return `<details${open ? " open" : ""}>\n<summary>${summary}</summary>\n\n${body}\n</details>`;
}

/** A heading, a reason, and findings listed under it. The only sections that can run long. */
export interface Listing {
    heading: string;
    lead: string;
    items: Finding[];
}

export type Section = string | Listing;

function isListing(section: Section): section is Listing {
    return typeof section !== "string";
}

/**
 * Join the sections into one body no longer than GitHub accepts.
 *
 * Everything except the finding listings is short, and it is the part that makes the
 * review honest: the counts, the lens health, what was suppressed, and the caveats saying
 * what the run could not check. So the listings get whatever length the rest leaves, and
 * they lose whole findings from the end rather than being cut at a character offset. An
 * offset lands inside a `<details>`, a fenced block, or a finding's own markup, and
 * GitHub renders the wreckage. What did not fit is counted and pointed at the artifact.
 *
 * Listings are filled in the order given, so put the one that matters most first.
 */
export function assemble(sections: Section[]): string {
    let budget =
        MAX_BODY -
        sections
            .filter((s): s is string => typeof s === "string")
            .reduce((total, s) => total + s.length + 2, 0);

    const rendered: string[] = [];

    for (const section of sections) {
        if (!isListing(section)) {
            rendered.push(section);
            continue;
        }

        const frame = `### ${section.heading}\n\n${section.lead}\n\n`;
        // Reserved for the omission line, so saying what went missing cannot itself be
        // the thing that does not fit.
        budget -= frame.length + 200;

        const kept: string[] = [];
        for (const finding of section.items) {
            const text = bullet(finding);
            if (text.length + 2 > budget) break;
            kept.push(text);
            budget -= text.length + 2;
        }

        const missing = section.items.length - kept.length;
        const omission =
            missing > 0
                ? `\n\n- _${plural(missing, "further finding")} left out for length. Every one of them is in \`findings.json\` in the \`codeferret-run\` artifact._`
                : "";

        rendered.push(`${frame}${kept.join("\n\n")}${omission}`);
    }

    const body = rendered.join("\n\n");

    // Reached only when the short sections alone exceed the limit, which takes a
    // lens_health list or a suppressed list of a size nothing here has seen.
    return body.length > MAX_BODY ? clamp(body, MAX_BODY) : body;
}

/**
 * Right-side line numbers per file that appear anywhere in a unified diff's hunks.
 *
 * A `+++` line is a header only when a `---` line precedes it, so an added line whose own
 * text begins with `++` cannot be read as one. A header this does not recognise clears the
 * current file rather than leaving the previous one named: losing an anchor demotes a
 * finding into the review body, while misplacing one fails the whole atomic review with
 * 422 and creates no comments at all. `+++ /dev/null` on a deleted file is the form that
 * reached a live run.
 */
export function anchorableLines(diff: string): Map<string, Set<number>> {
    const byFile = new Map<string, Set<number>>();
    let currentFile: string | null = null;
    let rightLine = 0;
    let previous = "";

    for (const line of diff.split("\n")) {
        const header = line.startsWith("+++ ") && previous.startsWith("--- ");
        previous = line;

        if (header) {
            const named = line.match(/^\+\+\+ b\/(.+)$/)?.[1];
            currentFile = named ?? null;
            if (currentFile && !byFile.has(currentFile)) byFile.set(currentFile, new Set());
            continue;
        }

        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            rightLine = Number(hunk[1]);
            continue;
        }

        if (!currentFile || line.startsWith("-")) continue;
        if (line.startsWith("+") || line.startsWith(" ")) {
            byFile.get(currentFile)?.add(rightLine);
            rightLine += 1;
        }
    }

    return byFile;
}

/** Whether a finding can be anchored inline, given the lines the diff makes commentable. */
export function anchorable(f: Finding, lines: Set<number> | undefined): boolean {
    // A finding with no `line` used to pass: `undefined <= undefined` is false, so the
    // loop below never ran and the guard stayed true. It reached GitHub as a comment with
    // no line, and the reviews endpoint answers 422 for the whole batch.
    if (lines === undefined || !Number.isInteger(f.line)) return false;

    const start = f.end_line ? Math.min(f.line, f.end_line) : f.line;
    const end = f.end_line ? Math.max(f.line, f.end_line) : f.line;

    for (let n = start; n <= end; n += 1) {
        if (!lines.has(n)) return false;
    }

    return true;
}

/**
 * How long to wait before retrying a refused review, or null when it was not a rate limit.
 *
 * A secondary rate limit comes back as 403 or 429, and both carry `retry-after`. Match only
 * one of those statuses, or sleep a fixed minute of our own, and the retry goes out after a
 * minute against a limit that asked for two: the wait is spent and it is refused again.
 */
export function rateLimitWait(status: number, retryAfter: string | null, detail: string): number | null {
    const RETRY_AFTER_MS = 60_000;
    const MAX_RETRY_AFTER_MS = 300_000;

    const limited = status === 429 || (status === 403 && /secondary rate limit/i.test(detail));

    if (!limited) return null;

    const asked = Number(retryAfter) * 1000;
    return asked > 0 ? Math.min(asked, MAX_RETRY_AFTER_MS) : RETRY_AFTER_MS;
}
