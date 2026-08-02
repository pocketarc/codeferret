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

/**
 * The severities the body carries in full.
 *
 * Everything else is in the findings file, which is what the agent doing the fixing reads.
 * A person reading the pull request gets the two that decide whether to stop and look.
 */
export const LISTED = new Set(["critical", "high"]);

/** GitHub refuses a review body over 65536 characters. The difference is headroom. */
export const MAX_BODY = 60000;

// The orchestrator writes both the summary and the notes, and nothing bounds what a model
// produces. Left unbounded, a runaway summary eats the length the findings need.
export const MAX_PROSE = 4000;

/** One lens's line about what it could not check. Every lens is asked for one. */
export const MAX_LENS_DETAIL = 600;

export function severityRank(s: string): number {
    const i = SEVERITY_ORDER.indexOf(s);
    return i === -1 ? SEVERITY_ORDER.length : i;
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
 * The body points at the run for every finding it does not list, and `local-post.sh` posts
 * from somebody's own machine, where there is no run and no artifact. So the environment
 * decides whether that sentence carries a link, rather than a URL being assembled out of
 * empty variables and going nowhere.
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
 * One finding as a bullet: where it is, what it is, and the body in full.
 *
 * The position comes first because the reader is usually an agent about to open the file.
 *
 * The continuation indent is two spaces. Four after a blank line is an indented code
 * block in markdown, which takes the formatting out of the body and stops it wrapping.
 * Two spaces still sit inside the list item's content column, so a body line opening with
 * `#` is an ATX heading, and one finding can emit an h1 into a review whose own title is
 * an h2.
 *
 * A body that opens a fence and never closes it takes everything after it into the code
 * block: the findings below, the suppressed and declined lists, the caveats. A truncated
 * example or a body quoting a fence is all it takes, so the fence is closed here before
 * the map is built, and the closing line is indented with the rest.
 */
export function bullet(f: Finding): string {
    const lines = closeOpenFence(f.body).split("\n");
    const fenced = fenceMap(lines);

    const body = lines
        .map((line, i) => (fenced[i] ? line : line.replace(/^(\s*)#/, "$1\\#")))
        .join("\n  ");

    // check-findings.ts keeps a finding whose category is missing rather than dropping it,
    // so the line goes rather than rendering the word "undefined" under the body.
    const category = f.category ? `\n\n  _${escapeInline(f.category)}_` : "";

    return `- \`${where(f)}\` — **${escapeInline(f.title)}**\n\n  ${body}${category}`;
}

/**
 * Where a finding sits, for a reader.
 *
 * A finding with no usable line still reaches the body, so the path alone is what there is
 * to say. Interpolating the number regardless printed the word "undefined" beside the file.
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

/** A heading, a reason, and findings listed under it. The one section that can run long. */
export interface Listing {
    heading: string;
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
        const heading = `### ${listing.heading}\n\n${listing.lead}`;
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

/** The whole review body: which sections appear, in what order, and under what headings. */
export function composeReview(merged: Merged, outcome: Outcome): string {
    const { fresh, suppressed, declined } = partition(merged.findings);
    const { resolved, resolveDenied, leftOpen, env } = outcome;

    const health = merged.lens_health ?? [];
    const brokenLenses = health.filter((h) => !h.ok);

    const counts = [`**${plural(fresh.length, "new finding")}**`];
    if (suppressed.length > 0) counts.push(`${suppressed.length} already commented on above`);
    if (declined.length > 0) counts.push(`${declined.length} raised before and declined`);

    const head: string[] = ["## CodeFerret"];

    if (merged.summary) head.push(clamp(merged.summary));

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
                // the item and drops the rest of the list out of the block.
                const detail = h.detail
                    ? `\n  ${escapeInline(clamp(h.detail, MAX_LENS_DETAIL).replace(/\n+/g, " "))}`
                    : "";
                return `- **${name}**: ${plural(h.findings_returned, "finding")}${flag}${detail}`;
            })
            .join("\n");

        if (brokenLenses.length > 0) {
            head.push(
                `> ${brokenLenses.length} of ${health.length} lenses did not report normally, so this review covers less than it appears to.`,
            );
        }

        const heading =
            brokenLenses.length > 0
                ? `${health.length} lenses ran, ${brokenLenses.length} needing attention`
                : `${health.length} lenses ran, all reporting`;

        head.push(details(heading, items, brokenLenses.length > 0));
    }

    const tail: string[] = [];

    if (suppressed.length > 0) {
        tail.push(
            details(
                `${plural(suppressed.length, "finding")} already commented on`,
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

    if (merged.notes) tail.push(`### Caveats\n\n${clamp(merged.notes)}`);

    // The whole review is in findings.json, so the body names where that file is rather than
    // reprinting it. Without a run to link, the sentence still has to say which file, because
    // a reader who cannot follow a link still needs to know what to ask for.
    const run = runUrl(env);
    const holdsEveryOne = run
        ? `\`findings.json\` in the \`codeferret-run\` artifact of [this run](${run}) holds every one`
        : "`findings.json` in the run's build directory holds every one";

    const listed = fresh.filter((f) => LISTED.has(f.severity));

    const listing: Listing | null =
        fresh.length === 0
            ? null
            : {
                  heading: listed.length > 0 ? "Critical and high findings" : "Findings",
                  lead:
                      listed.length > 0
                          ? `${listed.length} of ${plural(fresh.length, "finding")}. ${holdsEveryOne}.`
                          : `No finding is critical or high. ${holdsEveryOne}.`,
                  items: listed,
              };

    return assemble(head, listing, tail);
}
