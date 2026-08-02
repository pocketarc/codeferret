/**
 * The rendering a posted review is built from.
 *
 * Separated from post-review.ts so that `bun test` can reach it. Every function here is
 * pure over strings and JSON, and each one has a failure mode nothing downstream would
 * report: markdown a model did not mean to write renders as debris, and a budget that goes
 * negative drops the findings the body exists to carry.
 */

import { closeOpenFence, fenceMap } from "./markdown.ts";

export interface Finding {
    found_by?: string[];
    file: string;
    line: number;
    end_line?: number;
    /**
     * One of `SEVERITY_ORDER`, but typed as a string because check-findings.ts keeps a
     * finding whose severity it could not repair rather than dropping it. `isListed` and
     * `severityRank` are where an unrecognised label is decided on.
     */
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

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "nit", "question"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

/**
 * The severities the body carries in full when it has a run to defer the rest to.
 *
 * Everything else is in the findings file, which is what the agent doing the fixing reads.
 * A person reading the pull request gets the two that decide whether to stop and look.
 *
 * Declared as severities rather than as strings, so a name in this set that the schema no
 * longer has fails to compile instead of listing nothing at run time.
 */
const LISTED_SEVERITIES: readonly Severity[] = ["critical", "high"];

export const LISTED: ReadonlySet<string> = new Set(LISTED_SEVERITIES);

/** GitHub refuses a review body over 65536 characters. The difference is headroom. */
export const MAX_BODY = 60000;

// The orchestrator writes both the summary and the notes, and nothing bounds what a model
// produces. Left unbounded, a runaway summary eats the length the findings need.
export const MAX_PROSE = 4000;

/** One lens's line about what it could not check. Every lens is asked for one. */
export const MAX_LENS_DETAIL = 600;

export function severityRank(s: string): number {
    const i = SEVERITY_ORDER.findIndex((known) => known === s);
    return i === -1 ? SEVERITY_ORDER.length : i;
}

/**
 * Whether the body prints this finding in full rather than counting it.
 *
 * A severity the schema does not carry is listed. check-findings.ts lowercases and trims a
 * severity it can repair and keeps the finding either way, so what reaches here
 * unrecognised is a label nobody chose. Leaving a critical defect out of the comment on the
 * strength of a label nothing here recognises is the wrong way to be wrong.
 */
export function isListed(f: Finding): boolean {
    return LISTED.has(f.severity) || severityRank(f.severity) === SEVERITY_ORDER.length;
}

/** The lenses that did not report normally, which is the count the body leads with. */
export function brokenLenses(health: LensHealth[]): LensHealth[] {
    return health.filter((h) => !h.ok);
}

export interface Partitioned {
    all: Finding[];
    /** The ones this review posts. */
    fresh: Finding[];
    suppressed: Finding[];
    declined: Finding[];
}

/** Keeping a count of what was taken out makes a matcher that eats findings visible. */
export function partition(findings: Finding[]): Partitioned {
    const all = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    return {
        all,
        fresh: all.filter((f) => f.status !== "already-reported" && f.status !== "declined"),
        suppressed: all.filter((f) => f.status === "already-reported"),
        declined: all.filter((f) => f.status === "declined"),
    };
}

export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The workflow run this review came out of, or null when nothing names one.
 *
 * It is also what decides whether there is an artifact behind the review. On a runner the
 * findings file is one download away, so the body lists the critical and high findings and
 * links the rest. `local-post.sh` posts from somebody's own machine, where the findings
 * file is a path under `.git/` that means nothing to anyone else reading the pull request,
 * so there the body carries every finding instead.
 */
export function runUrl(env: Record<string, string | undefined>): string | null {
    const server = env.GITHUB_SERVER_URL;
    const repo = env.GITHUB_REPOSITORY;
    const id = env.GITHUB_RUN_ID;

    if (!server || !repo || !id) return null;

    return `${server}/${repo}/actions/runs/${id}`;
}

/**
 * Escape the markdown a model did not mean to write, leaving the markdown it did.
 *
 * A title naming a glob is the case that bites: a doubled asterisk opens strong emphasis,
 * so a bare `build` exclusion glob renders as emphasis debris rather than as a path. Text
 * inside a code span is left alone, because the orchestrator writes code spans
 * deliberately and escaping inside one puts backslashes on the page.
 *
 * The backslash is escaped first, and before anything else in the set, because one already
 * in the text cancels the escape put after it: `a\*b` would become `a\\*b`, a literal
 * backslash followed by a live asterisk. A title ending in one is worse, since `bullet`
 * wraps a title in `**`, and the trailing backslash then escapes the first closing
 * asterisk and the emphasis runs on into the body. Windows paths, regexes and LaTeX
 * fragments all reach a title.
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

            // Nothing closes it, so this opens no code span. Left alone it pairs with the
            // next backtick markdown finds, usually one in the finding's own body, and
            // renders everything between the two as code.
            out += "\\`".repeat(run);
            i += run;
            continue;
        }

        out += "\\*_[]<~".includes(char) ? `\\${char}` : char;
        i += 1;
    }

    return out;
}

/**
 * A model's one-line field on one line.
 *
 * `title` is asked for as one line and nothing checks that it is. A newline inside a list
 * item ends the item, so the rest of a suppressed or declined list renders outside the
 * `<details>` block it belongs to, and inside `bullet` the same newline closes the strong
 * emphasis and leaves a literal `**` on the page.
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
 * Escape the block a line would otherwise open.
 *
 * The review's own headings are an h2 and h3s below it, so a model's line opening with `#`
 * emits an h1 into the middle of the body, and heading level is what a screen reader
 * navigates by. `<` is worse: GitHub passes `<details>` and `<div>` through, and one left
 * unclosed hides everything after it, the suppressed list, the declined list and the
 * caveats included, which are where a reader learns how much of the review to trust.
 */
function escapeBlockStart(line: string): string {
    return line.replace(/^(\s*)([#<])/, "$1\\$2");
}

/** The same, over the lines of a block, leaving what is inside a fence alone. */
function escapeBlockStarts(lines: string[]): string[] {
    const fenced = fenceMap(lines);
    return lines.map((line, i) => (fenced[i] ? line : escapeBlockStart(line)));
}

/**
 * One finding as a bullet: where it is, what it is, and the body in full.
 *
 * The position comes first because the reader is usually an agent about to open the file.
 *
 * The continuation indent is two spaces. Four after a blank line is an indented code
 * block in markdown, which takes the formatting out of the body and stops it wrapping. Two
 * spaces still sit inside the list item's content column, which is why the body's lines go
 * through `escapeBlockStart`.
 *
 * A body that opens a fence and never closes it takes everything after it into the code
 * block: the findings below, the suppressed and declined lists, the caveats. A truncated
 * example or a body quoting a fence is all it takes, so the fence is closed here before
 * the map is built, and the closing line is indented with the rest.
 */
export function bullet(f: Finding): string {
    const body = escapeBlockStarts(closeOpenFence(f.body).split("\n")).join("\n  ");

    // check-findings.ts keeps a finding whose category is missing rather than dropping it,
    // so the line goes rather than rendering the word "undefined" under the body.
    const category = f.category ? `\n\n  _${escapeInline(f.category)}_` : "";

    return `- ${code(where(f))}: **${escapeInline(flatten(f.title))}**\n\n  ${body}${category}`;
}

/**
 * Where a finding sits, for a reader.
 *
 * A finding with no usable line still reaches the body, so the path alone is what there is
 * to say. check-findings.ts warns about a line of `0` or a missing one and keeps the
 * finding either way, and a reader following `path:0` from a terminal arrives nowhere.
 */
export function where(f: Finding): string {
    if (!Number.isInteger(f.line) || f.line < 1) return f.file;
    if (Number.isInteger(f.end_line) && f.end_line && f.end_line > f.line) {
        return `${f.file}:${f.line}-${f.end_line}`;
    }
    return `${f.file}:${f.line}`;
}

/** One finding as a single line, for the sections that only say a finding was seen. */
export function mention(f: Finding, link: string): string {
    const target = linkTarget(f.existing_comment_url);
    const url = target ? ` ([${link}](${target}))` : "";

    return `- ${escapeInline(flatten(f.title))} (${code(where(f))})${url}`;
}

/**
 * Prose the orchestrator wrote, cut to a length the findings can still fit around.
 *
 * Cut on the largest boundary inside the window and close whatever fence the cut left open.
 * A cut at a character offset lands mid-span or mid-fence, and an unbalanced fence renders
 * the counts, the lens health and every listed finding below it as one code block. The
 * paragraph is not always there to cut on: a lens's list of what it could not check is
 * often one paragraph or a run of single-newline lines, and that is the field where a cut
 * mid-word does the most damage.
 */
export function clamp(prose: string, limit = MAX_PROSE): string {
    if (prose.length <= limit) return prose;

    const window = prose.slice(0, limit);
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

/** Prose the orchestrator wrote, cut to length, with the blocks it would open escaped. */
export function prose(text: string, limit = MAX_PROSE): string {
    return escapeBlockStarts(clamp(text, limit).split("\n")).join("\n");
}

/** A collapsed block. GitHub renders nothing at all if the markup is a line out. */
export function details(summary: string, body: string, open = false): string {
    return `<details${open ? " open" : ""}>\n<summary>${summary}</summary>\n\n${body}\n</details>`;
}

/** A heading, a reason, and findings listed under it. The one section that can run long. */
export interface Listing {
    heading: string;
    /** Why these findings and not others. Empty when the section holds all of them. */
    lead: string;
    items: Finding[];
}

/**
 * Join the review into one body no longer than GitHub accepts.
 *
 * Everything but the listing is short, and it is the part that makes the review honest:
 * the counts, the lens health, what was suppressed, and the caveats saying what the run
 * could not check. So the listing gets whatever length the rest leaves, and it loses whole
 * findings from the end rather than being cut at a character offset. An offset lands
 * inside a `<details>`, a fenced block, or a finding's own markup, and GitHub renders the
 * wreckage. What did not fit is counted, and the reader is sent to the findings file,
 * which holds every finding whatever the body had room for.
 */
export function assemble(head: string[], listing: Listing | null, tail: string[]): string {
    let budget = MAX_BODY - [...head, ...tail].reduce((total, s) => total + s.length + 2, 0);

    const rendered = [...head];

    if (listing) {
        const heading = listing.lead ? `### ${listing.heading}\n\n${listing.lead}` : `### ${listing.heading}`;
        // Reserved for the omission line, so saying what went missing cannot itself be
        // the thing that does not fit.
        budget -= heading.length + 2 + 200;

        const kept: string[] = [];
        for (const finding of listing.items) {
            const text = bullet(finding);
            if (text.length + 2 > budget) break;
            kept.push(text);
            budget -= text.length + 2;
        }

        const missing = listing.items.length - kept.length;

        if (missing > 0) {
            kept.push(
                `- _${plural(missing, "further finding")} left out for length. Every one of them is in the findings file._`,
            );
        }

        rendered.push([heading, ...kept].join("\n\n"));
    }

    rendered.push(...tail);

    const body = rendered.join("\n\n");

    // Reached only when the short sections alone exceed the limit, which takes a
    // lens_health list or a suppressed list of a size nothing here has seen.
    return body.length > MAX_BODY ? clamp(body, MAX_BODY) : body;
}

/** The plugin namespace is an implementation detail, so it is dropped for display. */
export function lensLabel(lens: string): string {
    return lens.replace(/^[^:]+:/, "");
}

/** What became of the threads the orchestrator asked to close, which the body reports. */
export interface Outcome {
    resolved: Array<{ reason: string }>;
    resolveDenied: boolean;
    /** How many threads judged finished that refusal left open. */
    leftOpen: number;
    env: Record<string, string | undefined>;
}

/**
 * The whole review body: which sections appear, in what order, and under what headings.
 *
 * The partition is a parameter so that a caller counting the same findings for its log
 * counts them once. Left to a default, the two derivations drift the day anything filters
 * or re-orders before calling this, and the body and the log then describe different
 * reviews with nothing saying so.
 */
export function composeReview(
    merged: Merged,
    outcome: Outcome,
    parts: Partitioned = partition(merged.findings),
): string {
    const { fresh, suppressed, declined } = parts;
    const { resolved, resolveDenied, leftOpen, env } = outcome;

    const health = merged.lens_health ?? [];
    const broken = brokenLenses(health);
    const limited = health.filter((h) => h.detail);

    const counts = [`**${plural(fresh.length, "new finding")}**`];
    if (suppressed.length > 0) counts.push(`${suppressed.length} raised in an earlier review`);
    if (declined.length > 0) counts.push(`${declined.length} raised before and declined`);

    const head: string[] = ["## CodeFerret"];

    if (merged.summary) head.push(prose(merged.summary));

    // A screen reader speaks a separator between joined counts as nothing, so three of them
    // run into each other. Past one, they are a list.
    const [onlyCount] = counts;
    head.push(counts.length === 1 && onlyCount ? onlyCount : counts.map((c) => `- ${c}`).join("\n"));

    if (health.length > 0) {
        // A list, not a table: GitHub gives a wide column the container and starves the
        // rest, and most lenses report no detail at all. Punctuation a screen reader speaks,
        // for the reason the counts above are a list.
        const items = health
            .map((h) => {
                const name = escapeInline(lensLabel(h.lens));
                const flag = h.ok ? "" : ", **needs attention**";
                // Escaped because this list sits inside the `<details>` block below it, and a
                // lens that reports what it could not check writes about markup. One wrote
                // "the native <details> disclosures", which opens a second block whose close
                // takes the outer one's `</details>`, and the rest of the review disappears
                // into it.
                // Clamped before it is flattened, because the cut marker `clamp` appends
                // carries newlines of its own, and one of those inside a list item ends
                // the item and drops the rest of the list out of the block. `escapeInline`
                // leaves `#` and `>` alone, and the flattened line starts at the item's own
                // content column, where either one opens a block of its own.
                const detail = h.detail
                    ? `\n  ${escapeInline(clamp(h.detail, MAX_LENS_DETAIL).replace(/\n+/g, " ")).replace(/^([#>])/, "\\$1")}`
                    : "";
                return `- **${name}**: ${plural(h.findings_returned, "finding")}${flag}${detail}`;
            })
            .join("\n");

        // What a lens could not check is the one thing in this block a reader has to see
        // without opening it: a reader takes a review of an interface change for an
        // accessibility pass unless something names the criteria nothing evaluated.
        if (broken.length > 0) {
            head.push(
                `> ${broken.length} of ${health.length} lenses did not report normally, so this review covers less than it appears to.`,
            );
        } else if (limited.length > 0) {
            head.push(
                `> ${limited.length} of ${health.length} lenses named something they could not check. The list below has each in its own words.`,
            );
        }

        const heading =
            broken.length > 0
                ? `${health.length} lenses ran, ${broken.length} needing attention`
                : `${health.length} lenses ran, all reporting`;

        head.push(details(heading, items, broken.length > 0));
    }

    const tail: string[] = [];

    if (suppressed.length > 0) {
        tail.push(
            details(
                `${plural(suppressed.length, "finding")} raised in an earlier review`,
                suppressed.map((f) => mention(f, "earlier comment")).join("\n"),
            ),
        );
    }

    if (declined.length > 0) {
        tail.push(
            details(
                `${plural(declined.length, "finding")} raised before and declined`,
                declined.map((f) => mention(f, "thread")).join("\n"),
            ),
        );
    }

    if (resolved.length > 0) {
        tail.push(
            details(
                `${plural(resolved.length, "thread")} resolved`,
                resolved.map((r) => `- ${escapeInline(r.reason.replace(/\n+/g, " "))}`).join("\n"),
            ),
        );
    }

    if (resolveDenied) {
        tail.push(
            `> ${plural(leftOpen, "thread")} judged finished could not be resolved:` +
                ` the workflow grants \`pull-requests: write\`, and \`resolveReviewThread\` needs` +
                ` \`contents: write\`.`,
        );
    }

    if (merged.notes) tail.push(`### Caveats\n\n${prose(merged.notes)}`);

    // With a run behind it the body prints the two severities that decide whether to stop
    // and names the artifact for the rest, because that artifact is one download away for
    // everybody reading the pull request. Posted from a session there is no artifact and no
    // run, and the findings file is a path under `.git/` on one person's machine, so every
    // finding goes in the body instead. `assemble` still bounds it and says how many did
    // not fit.
    const run = runUrl(env);
    const listed = run ? fresh.filter(isListed) : fresh;

    let listing: Listing | null = null;

    if (listed.length > 0) {
        listing = {
            heading: run ? "Critical and high findings" : "Findings",
            lead: run
                ? `${listed.length} of ${plural(fresh.length, "finding")}.` +
                  ` \`findings.json\` in the \`codeferret-run\` artifact of [this run](${run}) holds every one.`
                : "",
            items: listed,
        };
    } else if (fresh.length > 0 && run) {
        // A heading is a promise of something under it, and the count is already above.
        tail.unshift(
            `No finding is critical or high.` +
                ` \`findings.json\` in the \`codeferret-run\` artifact of [this run](${run}) holds every one.`,
        );
    }

    return assemble(head, listing, tail);
}
