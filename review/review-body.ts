/**
 * The rendering a posted review is built from.
 *
 * Every function here is pure over strings and JSON, and each one has a failure mode
 * nothing downstream would report: markdown a model did not mean to write renders as
 * debris, and a budget that goes negative drops the findings the body exists to carry. What
 * a run produced is in `findings.ts`; what a character does to markdown is in
 * `markdown.ts`.
 */

import { brokenLenses, isListed, LISTED } from "./findings.ts";
import type { Finding, LensHealth, Merged, Partitioned } from "./findings.ts";
import {
    clamp,
    closeOpenDetails,
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

/** GitHub's limit on a review body is 65536 characters. The difference is headroom. */
export const MAX_BODY = 60000;

/**
 * A count and its noun.
 *
 * Only the noun is inflected, so the phrase around it has to read at either count: "1
 * finding were raised" is what a hard-coded plural verb next to one of these produces.
 */
export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The one noun in the review that does not take an `s`. */
export function lenses(n: number): string {
    return n === 1 ? "1 lens" : `${n} lenses`;
}

// The orchestrator writes both the summary and the notes, and nothing bounds what a model
// produces. Left unbounded, a runaway summary eats the length the findings need.
export const MAX_PROSE = 4000;

/**
 * One lens's account of what it could not check. Every lens is asked for one.
 *
 * Wide enough for a full answer to an interface change, which is a dozen WCAG criteria
 * with a clause each. The budget does not need it back: fourteen of these is a fraction of
 * `MAX_BODY`, the listing is the elastic section, and a listed finding cut for length is
 * still in the findings file where a clipped caveat is nowhere.
 */
export const MAX_LENS_DETAIL = 2000;

/** One finding's body. check-findings.ts asks only that it be a non-empty string. */
export const MAX_FINDING_BODY = 4000;

/**
 * One finding's title, which is asked for as one line and checked only for being a string.
 *
 * Generous for a line. What this stops is the runaway: a title of several hundred
 * characters renders as an unbroken run of bold text where the reader wanted something to
 * scan, and `mention` puts titles into two lists `assemble` never budgets.
 */
export const MAX_TITLE = 200;

/** Where this review is being posted. `listedIn` reads it to bound what the body carries. */
export type Destination = { kind: "run"; url: string; artifact: boolean } | { kind: "session" };

/**
 * Which of the two this run is, and whether it kept the findings file.
 *
 * Answered once, at the boundary: five branches over the same three environment variables
 * is five chances for the body and the log beside it to describe different reviews.
 *
 * `ARTIFACT_HAS_FINDINGS` is the action's own answer, decided in the step that resolves
 * `artifact-path` and passed through to the step that posts. Without it, a caller who set
 * `artifact-path` to `''` or to one tool report gets a body that drops every finding below
 * high and sends the reader to a file nobody uploaded.
 */
export function destinationOf(env: Record<string, string | undefined>): Destination {
    const server = env.GITHUB_SERVER_URL;
    const repo = env.GITHUB_REPOSITORY;
    const id = env.GITHUB_RUN_ID;

    if (!server || !repo || !id) return { kind: "session" };

    return {
        kind: "run",
        url: `${server}/${repo}/actions/runs/${id}`,
        artifact: env.ARTIFACT_HAS_FINDINGS === "true",
    };
}

/** The run whose artifact holds the findings this body leaves out, where there is one. */
function deferredTo(to: Destination): string | null {
    return to.kind === "run" && to.artifact ? to.url : null;
}

/**
 * The findings the body prints in full.
 *
 * With an artifact behind it the body prints the severities a reader should stop for and
 * names that artifact for the rest, because it is one download away for everybody reading
 * the pull request. With nothing behind it (a session, whose findings file is a path under
 * `.git/` on one person's machine, or a run that kept no artifact) every finding goes in the
 * body instead, since there is nowhere else to read it.
 *
 * Exported because post-review.ts logs this count beside the ones `partition` gives it,
 * and a log line that contradicts the body it describes is worse than no log line.
 */
export function listedIn(fresh: Finding[], to: Destination): Finding[] {
    return deferredTo(to) ? fresh.filter(isListed) : fresh;
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
    // so this line is omitted. Rendering it anyway puts the word "undefined" under the body.
    const category = f.category ? `\n\n  _${escapeInline(f.category)}_` : "";

    return `- ${code(where(f))}: **${title(f)}**\n\n  ${body}${category}`;
}

/**
 * A finding's title as one bounded line.
 *
 * Escaped before the cut, for the reason `lensDetail` gives: the marker `clamp` appends is
 * markdown of its own and must not be escaped and shown as underscores. Flattened again
 * after it, because that marker carries newlines, and one inside `bullet`'s strong emphasis
 * closes it and leaves a literal `**` on the page.
 */
function title(f: Finding): string {
    return flatten(clamp(escapeInline(flatten(f.title)), MAX_TITLE));
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

/**
 * One finding as a single line, for the sections that only say a finding was seen.
 *
 * `linkable` is every comment url the pull request actually carries. `existing_comment_url`
 * is the orchestrator's word for where a finding was answered, and an `already-reported`
 * finding takes no vetting anywhere else, so without the check a comment written by anyone
 * who can comment can put an arbitrary link into a review posted under the bot's name.
 */
export function mention(f: Finding, link: string, linkable: ReadonlySet<string>): string {
    const cited = f.existing_comment_url;
    const target = cited && linkable.has(cited) ? linkTarget(cited) : null;
    const url = target ? ` ([${link}](${target}))` : "";

    return `- ${title(f)} (${code(where(f))})${url}`;
}

/**
 * One lens's account of what it could not check, as a paragraph of its own inside the list
 * item.
 *
 * A blank line and the item's content indent, rather than a single newline: a soft break
 * joins the caveat onto the count above it, leaving the one channel a reader has for what a
 * lens could not cover buried in the middle of that line. Four spaces would be an indented
 * code block.
 *
 * Escaped before the cut, so the marker `clamp` appends is not itself escaped and shown to
 * the reader as underscores. Flattened again after it, because that marker carries newlines
 * of its own, and one of those into column zero ends the item and drops the rest of the list
 * out of the block.
 *
 * The line starts at the item's own content column, where a `#` or a `>` opens a block of
 * its own, and `escapeInline` leaves both alone.
 */
function lensDetail(detail: string): string {
    const line = escapeBlockStart(escapeInline(flatten(detail)));

    return `\n\n  ${flatten(clamp(line, MAX_LENS_DETAIL))}`;
}

/**
 * What a lens could not check, whatever it reported.
 *
 * Two lenses ship without the capability their skills describe, and every step that would
 * carry that as far as the reader is a soft one: the lens is asked to write its limits down,
 * and the orchestrator to copy them into `detail`. Either can forget, and then a pull request full
 * of interface changes comes back looking as though its accessibility had been checked,
 * which is the failure `review/lens-extras/anthropic-accessibility-review.md` exists to
 * prevent. A standing sentence is worse than the lens's own words and cannot be forgotten.
 */
export const STANDING_DETAIL: ReadonlyMap<string, string> = new Map([
    [
        "anthropic-accessibility-review",
        "No page was rendered, so contrast, focus order, target size, reflow, text spacing," +
            " timing and motion were not evaluated.",
    ],
    ["copilot-web-design-reviewer", "No browser was available, so nothing was judged from a rendered page."],
]);

/**
 * The standing sentence and the lens's own words together, or nothing where there is
 * neither.
 *
 * Both, rather than whichever is there. A lens told to report what it could not check
 * usually answers about the diff ("no markup or styles in it"), and that is a different fact
 * from having had no browser to look at one. Shown the first alone, a reader takes the
 * interface for looked at and unremarkable.
 *
 * A `Map` rather than an object literal: a lens named `constructor` or `toString` gets
 * nothing back, where a literal would hand over an inherited function for `flatten` to call.
 */
export function caveatOf(h: LensHealth): string | undefined {
    const both = [STANDING_DETAIL.get(lensLabel(h.lens)), h.detail].filter((s) => s);

    return both.length > 0 ? both.join(" ") : undefined;
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
 * A finding too long for what is left costs only itself. `partition` orders by severity, so
 * stopping at the first one that does not fit would let a verbose critical finding at the
 * top empty the whole section.
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

    return body.length > MAX_BODY ? fit(body) : body;
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
 * The reserve is for the two closers, and overrunning it costs nothing: `MAX_BODY` is
 * already 5536 characters under GitHub's limit.
 */
function fit(body: string): string {
    const notice = "\n\n_(this review was cut for length)_";

    return `${closeOpenDetails(closeOpenFence(body.slice(0, MAX_BODY - notice.length - 200)))}${notice}`;
}

/** The plugin namespace is an implementation detail, so it is dropped for display. */
export function lensLabel(lens: string): string {
    return lens.replace(/^[^:]+:/, "");
}

/** Everything about this posting that is not the findings themselves. */
export interface Posting {
    /** What became of the threads the orchestrator asked to close, which the body reports. */
    resolved: Array<{ reason: string }>;
    resolveDenied: boolean;
    /** How many threads judged finished that refusal left open. */
    leftOpen: number;
    to: Destination;
    /** Every comment url the pull request carries, which is what `mention` may link. */
    linkable: ReadonlySet<string>;
}

/** A body and the two views of the run it was built from, for the log line beside it. */
export interface Composed {
    body: string;
    /** The findings the body printed in full. */
    listed: Finding[];
    /** The lenses it flagged as needing attention. */
    broken: LensHealth[];
}

/**
 * The whole review body: which sections appear, in what order, and under what headings.
 *
 * The partition is a parameter so that a caller counting the same findings for its log
 * counts them once. It is required for the same reason: a default would let a caller that
 * has already filtered or re-ordered pass nothing and get a second partition of a different
 * list, and the body and the log would then describe different reviews with nothing saying
 * so.
 *
 * The two views this function derives for itself come back out for the same reason. Both
 * decide something the caller acts on (one is the count it logs, the other is what makes a
 * run with no findings worth posting anyway), and a second derivation is a second answer.
 */
export function composeReview(merged: Merged, posting: Posting, parts: Partitioned): Composed {
    const { fresh, suppressed, declined } = parts;
    const { resolved, resolveDenied, leftOpen, to, linkable } = posting;

    const health = merged.lens_health ?? [];
    const broken = brokenLenses(health);
    const limited = health.filter((h) => caveatOf(h));

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
                const caveat = caveatOf(h);
                const detail = caveat ? lensDetail(caveat) : "";

                // The colon separates the name from its count, so the one bold left in the
                // list is the exception a reader has to see.
                return `- ${name}: ${plural(h.findings_returned, "finding")}${flag}${detail}`;
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
                suppressed.map((f) => mention(f, "earlier comment", linkable)).join("\n"),
            ),
        );
    }

    if (declined.length > 0) {
        tail.push(
            details(
                `${plural(declined.length, "finding")} raised before and declined`,
                declined.map((f) => mention(f, "thread", linkable)).join("\n"),
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
    const listed = listedIn(fresh, to);
    const artifact = deferredTo(to);

    let listing: Listing | null = null;

    if (listed.length > 0) {
        listing = {
            heading: artifact ? listingHeading(listed) : "Findings",
            lead: artifact
                ? `${listed.length} of ${plural(fresh.length, "finding")}.` +
                  ` \`findings.json\` in the \`codeferret-run\` artifact of [this run](${artifact}) holds every one.`
                : "",
            omission: omissionFor(to),
            items: listed,
        };
    } else if (fresh.length > 0 && artifact) {
        // A heading is a promise of something under it, and the count is already above.
        tail.unshift(
            `No finding is critical or high.` +
                ` \`findings.json\` in the \`codeferret-run\` artifact of [this run](${artifact}) holds every one.`,
        );
    }

    return { body: assemble(head, listing, tail), listed, broken };
}

/** Where to read a finding the listing had no room for. */
function omissionFor(to: Destination): string {
    if (deferredTo(to)) return "Every one of them is in the findings file.";
    if (to.kind === "run") return "This run kept no artifact, so the rest are in its log and nowhere else.";

    return "This review was posted from a session, so ask whoever ran it for the rest.";
}

/**
 * What to call the section, which depends on what `isListed` let through.
 *
 * The heading has to follow the same policy as `isListed`: `bullet` prints no severity, so
 * under the narrower title a reader has no way to tell that a finding graded neither
 * critical nor high is in the list.
 */
function listingHeading(listed: Finding[]): string {
    return listed.every((f) => LISTED.has(f.severity)) ? "Critical and high findings" : "Findings worth stopping for";
}
