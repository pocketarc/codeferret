/**
 * The rendering a posted review is built from.
 *
 * Every function here is pure over strings and JSON, and each one has a failure mode
 * nothing downstream would report: markdown a model did not mean to write renders as
 * debris, and a budget that goes negative drops the findings the body exists to carry. What
 * a run produced is in `findings.ts`; what a character does to markdown is in
 * `markdown.ts`.
 */

import { brokenLenses, isListed, lenses, partition, plural } from "./findings.ts";
import type { Finding, Merged, Partitioned } from "./findings.ts";
import {
    clamp,
    closeOpenFence,
    code,
    details,
    escapeBlocks,
    escapeBlockStart,
    escapeInline,
    flatten,
    linkTarget,
    prose,
} from "./markdown.ts";

/** GitHub refuses a review body over 65536 characters. The difference is headroom. */
export const MAX_BODY = 60000;

// The orchestrator writes both the summary and the notes, and nothing bounds what a model
// produces. Left unbounded, a runaway summary eats the length the findings need.
export const MAX_PROSE = 4000;

/**
 * One lens's account of what it could not check. Every lens is asked for one.
 *
 * Wide enough for the honest answer to an interface change, which is a dozen WCAG criteria
 * with a clause each. The budget does not need it back: fourteen of these is a fraction of
 * `MAX_BODY`, the listing is the elastic section, and a listed finding cut for length is
 * still in the findings file where a clipped caveat is nowhere.
 */
export const MAX_LENS_DETAIL = 2000;

/**
 * One finding's body, which is the only model-written prose in the review that nothing
 * upstream bounds. check-findings.ts asks only that it be a non-empty string.
 */
export const MAX_FINDING_BODY = 4000;

/** The workflow run this review came out of, or null when nothing names one. */
export function runUrl(env: Record<string, string | undefined>): string | null {
    const server = env.GITHUB_SERVER_URL;
    const repo = env.GITHUB_REPOSITORY;
    const id = env.GITHUB_RUN_ID;

    if (!server || !repo || !id) return null;

    return `${server}/${repo}/actions/runs/${id}`;
}

/**
 * The findings the body prints in full.
 *
 * With a run behind it the body prints the two severities that decide whether to stop and
 * names the artifact for the rest, because that artifact is one download away for
 * everybody reading the pull request. Posted from a session there is no artifact and no
 * run, and the findings file is a path under `.git/` on one person's machine, so every
 * finding goes in the body instead.
 *
 * Exported because post-review.ts logs this count beside the ones `partition` gives it,
 * and a log line that contradicts the body it describes is worse than no log line: a
 * 97-finding session run once logged `listed=6` beside a body carrying all 97.
 */
export function listedIn(fresh: Finding[], env: Record<string, string | undefined>): Finding[] {
    return runUrl(env) ? fresh.filter(isListed) : fresh;
}

/**
 * One finding as a bullet: where it is, what it is, and the body.
 *
 * The position comes first because the reader is usually an agent about to open the file.
 *
 * The continuation indent is two spaces. Four after a blank line is an indented code block
 * in markdown, which takes the formatting out of the body and stops it wrapping. Two spaces
 * still sit inside the list item's content column, which is why the body's lines go through
 * `escapeBlocks`.
 *
 * A body that opens a fence and never closes it takes everything after it into the code
 * block: the findings below, the suppressed and declined lists, the caveats. A truncated
 * example or a body quoting a fence is all it takes, so the fence is closed here before the
 * map is built, and the closing line is indented with the rest.
 */
export function bullet(f: Finding): string {
    const body = escapeBlocks(closeOpenFence(clamp(f.body, MAX_FINDING_BODY)).split("\n")).join("\n  ");

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
 * One lens's line in the collapsed list.
 *
 * Escaped before the cut rather than after, so the marker `clamp` appends is not itself
 * escaped and shown to the reader as underscores. Flattened again after it, because that
 * marker carries newlines of its own, and one of those inside a list item ends the item and
 * drops the rest of the list out of the block.
 *
 * The line starts at the item's own content column, where a `#` or a `>` opens a block of
 * its own, and `escapeInline` leaves both alone.
 */
function lensDetail(detail: string): string {
    const line = escapeBlockStart(escapeInline(flatten(detail)));

    return `\n  ${flatten(clamp(line, MAX_LENS_DETAIL))}`;
}

/** A heading, a reason, and findings listed under it. The one section that can run long. */
export interface Listing {
    heading: string;
    /** Why these findings and not others. Empty when the section holds all of them. */
    lead: string;
    /** Where to read the findings this section had no room for. */
    omission: string;
    items: Finding[];
}

/**
 * Join the review into one body no longer than GitHub accepts.
 *
 * Everything but the listing is short, and it is the part that makes the review honest: the
 * counts, the lens health, what was suppressed, and the caveats saying what the run could
 * not check. So the listing gets whatever length the rest leaves, and it loses whole
 * findings rather than being cut at a character offset. An offset lands inside a
 * `<details>`, a fenced block, or a finding's own markup, and GitHub renders the wreckage.
 *
 * A finding too long for what is left costs only itself. `partition` orders by severity
 * rather than by length, so stopping at the first one that does not fit would let a verbose
 * critical finding at the top empty the whole section.
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
            if (text.length + 2 > budget) continue;
            kept.push(text);
            budget -= text.length + 2;
        }

        const missing = listing.items.length - kept.length;

        if (missing > 0) {
            kept.push(`- _${plural(missing, "further finding")} left out for length. ${listing.omission}_`);
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

    if (merged.summary) head.push(prose(merged.summary, MAX_PROSE));

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
                const detail = h.detail ? lensDetail(h.detail) : "";

                return `- **${name}**: ${plural(h.findings_returned, "finding")}${flag}${detail}`;
            })
            .join("\n");

        // What a lens could not check is the one thing in this block a reader has to see
        // without opening it: a reader takes a review of an interface change for an
        // accessibility pass unless something names the criteria nothing evaluated. The
        // alert syntax is what the job summary uses for the same class of warning.
        if (broken.length > 0) {
            head.push(
                `> [!WARNING]\n> ${broken.length} of ${lenses(health.length)} did not report normally,` +
                    " so this review covers less than it appears to.",
            );
        } else if (limited.length > 0) {
            head.push(
                `> [!NOTE]\n> ${limited.length} of ${lenses(health.length)} named something they could not check.` +
                    " The list below has each in its own words.",
            );
        }

        const heading =
            broken.length > 0
                ? `${lenses(health.length)} ran, ${broken.length} needing attention`
                : `${lenses(health.length)} ran, all reporting`;

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
                resolved.map((r) => `- ${escapeInline(flatten(r.reason))}`).join("\n"),
            ),
        );
    }

    if (resolveDenied) {
        tail.push(
            `> [!WARNING]\n> ${plural(leftOpen, "thread")} judged finished could not be resolved:` +
                ` the workflow grants \`pull-requests: write\`, and \`resolveReviewThread\` needs` +
                ` \`contents: write\`.`,
        );
    }

    if (merged.notes) tail.push(`### Caveats\n\n${prose(merged.notes, MAX_PROSE)}`);

    // `assemble` bounds the listing whichever branch this takes, and says how many findings
    // did not fit.
    const run = runUrl(env);
    const listed = listedIn(fresh, env);

    let listing: Listing | null = null;

    if (listed.length > 0) {
        listing = {
            heading: run ? "Critical and high findings" : "Findings",
            lead: run
                ? `${listed.length} of ${plural(fresh.length, "finding")}.` +
                  ` \`findings.json\` in the \`codeferret-run\` artifact of [this run](${run}) holds every one.`
                : "",
            omission: run
                ? "Every one of them is in the findings file."
                : "This review was posted from a session, so ask whoever ran it for the rest.",
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
