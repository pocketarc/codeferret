/**
 * What a posted review says: which sections appear, in what order, and how each one is
 * rendered.
 *
 * Every function here is pure over strings and JSON, and each one has a failure mode nothing
 * downstream would report: markdown a model did not mean to write renders as debris. What a run
 * produced is in `findings.ts`; what a character does to markdown is in `markdown.ts`; what the
 * run says about itself, in the words a printed review uses too, is in `caveats.ts`; and how the
 * whole of it is fitted into the length GitHub accepts is in `body-budget.ts`, which names no
 * finding of its own and is handed the items and how to render them.
 */

import { ARTIFACT_NAME } from "./artifact.ts";
import { FINDINGS_FILE } from "./artifact-path.ts";
import { assemble, boundedBlock } from "./body-budget.ts";
import type { Listing } from "./body-budget.ts";
import { caveatOf, COVERAGE_NOTICES, coverageOf, noticesFor, raisedIn } from "./caveats.ts";
import type { Coverage, CoverageAlert, Notice, RunFacts } from "./caveats.ts";
import { findingRank, isPrinted, lensLabel, lineOf } from "./findings.ts";
import type { Finding, Merged, Partitioned, Tier } from "./findings.ts";
import { lenses, plural } from "./words.ts";
import {
    clamp,
    clampTo,
    CUT_INLINE,
    closeOpenFence,
    code,
    details,
    escapeBlocks,
    escapeBlockStart,
    escapeInline,
    flatten,
    linkTarget,
    prose,
    splitLines,
} from "./markdown.ts";

// The orchestrator writes both the summary and the notes, and nothing bounds what a model
// produces. Left unbounded, a runaway summary eats the length the findings need.
const MAX_PROSE = 4000;

/**
 * One lens's account of what it could not check. Every lens is asked for one.
 *
 * Wide enough for a full answer to an interface change, which is a dozen WCAG criteria
 * with a clause each. The budget does not need it back: one of these per lens is a fraction
 * of `MAX_BODY`, the listing is the elastic section, and a listed finding cut for length is
 * still in the findings file where a clipped caveat is nowhere.
 */
export const MAX_LENS_DETAIL = 2000;

/** One finding's body. check-findings.ts asks only that it be a non-empty string. */
const MAX_FINDING_BODY = 4000;

/**
 * One finding's title, which is asked for as one line and checked only for being a string.
 *
 * Generous for a line. What this stops is the runaway: a title of several hundred
 * characters renders as an unbroken run of bold text where the reader wanted something to
 * scan, and `mention` puts titles into two lists `assemble` never budgets.
 */
export const MAX_TITLE = 200;

/**
 * A finding's path, which arrives from the model and is checked only for being a non-empty
 * string.
 *
 * Long enough for any path a repository holds, including a monorepo's. What it stops is the
 * runaway: `code(where(f))` and `mention` both wrap this without a bound of their own, and
 * `assemble` charges the whole tail against the body before it measures a single finding
 * bullet, so forty suppressed findings each carrying a multi-kilobyte path drive the budget
 * negative and every fresh finding is skipped.
 *
 * The cut is marked with an ellipsis rather than `clampTo`'s marker, because the result goes
 * inside a code span where markdown is text.
 */
export const MAX_PATH = 200;

/**
 * A finding's category, which is a slug in every finding that has one.
 *
 * Bounded for the reason the path is. `bullet` renders it as a line of its own under the body,
 * where a runaway is both a wall of italics and length `assemble` charged the section for.
 */
const MAX_CATEGORY = 100;

/**
 * A lens's name, as the orchestrator reported it.
 *
 * `merged-schema.json` declares `lens_health[].lens` as a bare string, so this is unconstrained
 * model output rendered at a list item's content column. Unbounded, the only thing left holding
 * a runaway out of the body is `boundedBlock` dropping that lens's whole line, which costs the
 * reader the lens.
 */
const MAX_LENS_NAME = 100;

/**
 * Where this review is being posted. `listedIn` reads it to bound what the body carries.
 *
 * Each destination has a variant of its own. With a pair of variants and an `artifact` boolean
 * instead, no reader read the boolean: each folded it back into "is there a run holding the
 * rest" and then asked `kind` as well to tell the rest apart, so the one question took two
 * answers.
 *
 * Only `artifact` carries a url, because it is the only destination with anywhere to send a
 * reader. A run that kept no artifact kept the rest nowhere, and `omissionFor` says so instead
 * of linking.
 */
export type Destination = { kind: "artifact"; url: string } | { kind: "run" } | { kind: "session" };

/**
 * Which destination this run is posting to.
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
    if (env.ARTIFACT_HAS_FINDINGS !== "true") return { kind: "run" };

    return { kind: "artifact", url: `${server}/${repo}/actions/runs/${id}` };
}

/**
 * Where this run leaves a finding the body does not print, or null where it keeps it nowhere.
 *
 * The one place the variant is tested for, so that one question gets one answer.
 */
export function artifactUrl(to: Destination): string | null {
    return to.kind === "artifact" ? to.url : null;
}

/**
 * Whether the run has somewhere to leave the findings the body does not print in full.
 *
 * The same question the url answers, because only `artifact` carries one. `isPrinted` takes
 * this beside the threshold, and the two have to be the same answer wherever they are asked: if
 * the body decides one way and the suppression bar the other, a finding is printed in full while
 * a closed thread may still settle it for the life of the pull request.
 */
export function defers(to: Destination): boolean {
    return artifactUrl(to) !== null;
}

/**
 * The findings the body prints in full.
 *
 * With an artifact behind it the body prints what scored at the threshold or above and names
 * that artifact for the rest, because it is one download away for everybody reading the pull
 * request. With nothing behind it (a session, whose findings file is a path under `.git/` on
 * one person's machine, or a run that kept no artifact) every finding goes in the body
 * instead, since there is nowhere else to read it, and the threshold decides nothing.
 */
function listedIn(fresh: Finding[], to: Destination, threshold: Tier): Finding[] {
    return fresh.filter((f) => isPrinted(f, threshold, defers(to)));
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
    const body = escapeBlocks(splitLines(closeOpenFence(clamp(f.body, MAX_FINDING_BODY)))).join("\n  ");

    // Checked for being a string, because the rule that keeps a finding with a bad category
    // tolerates whatever the model sent: a number here reaches `escapeInline`, comes back
    // empty, and leaves a bare `__` on a line of its own.
    //
    // check-findings.ts keeps a finding whose category is missing rather than dropping it,
    // so this line is omitted. Rendering it anyway puts the word "undefined" under the body.
    const { kept, marker } = clampTo(typeof f.category === "string" ? flatten(f.category) : "", MAX_CATEGORY);
    const label = escapeInline(kept);
    // The marker sits outside the emphasis, because `clampTo` writes it as markdown of its own
    // and a second pair of underscores inside the first renders as literal punctuation.
    const cut = marker === "" ? "" : CUT_INLINE;
    const category = label === "" ? "" : `\n\n  _${label}_${cut}`;

    return `- ${code(where(f))}: **${title(f)}**\n\n  ${body}${category}`;
}

/**
 * A model's one-line field, as one bounded line safe at a list item's content column.
 *
 * Cut first and escaped after, with the marker appended last. The marker is markdown of its
 * own and must not be escaped and shown to the reader as underscores, and escaping first put
 * the cut inside a code span `escapeInline` had already balanced: `clampTo` has the
 * measurement. Escaping the cut text hands that dangling backtick run to the branch of
 * `escapeOutsideCode` written for one. The limit therefore bounds the field before the
 * backslashes go in, and what bounds the body is `assemble` measuring it.
 *
 * Flattened after, because the marker carries newlines, and one inside `bullet`'s strong
 * emphasis closes it and leaves a literal `**` on the page.
 *
 * `escapeBlockStart` because `mention` and the resolved list both put one of these where a
 * `- ` item's content starts, and `escapeInline` leaves `#` and `>` alone: a title of
 * `# Fix the parser` rendered an h1 in the middle of the suppressed list. Inside `bullet`
 * the same string sits between two asterisks where neither opens anything, and the escape
 * costs a backslash the renderer takes back off.
 */
function oneLine(text: string, limit: number): string {
    const { kept, marker } = clampTo(flatten(text), limit);

    return flatten(`${escapeBlockStart(escapeInline(kept))}${marker}`);
}

/** A finding's title as one bounded line. */
function title(f: Finding): string {
    return oneLine(f.title, MAX_TITLE);
}

/**
 * Where a finding sits, for a reader.
 *
 * A finding with no usable line still reaches the body, so the path alone is what there is
 * to say. check-findings.ts warns about a line of `0` or a missing one and keeps the
 * finding either way, and a reader following `path:0` from a terminal arrives nowhere.
 */
export function where(f: Finding): string {
    const line = lineOf(f);
    const file = boundedPath(f.file);

    if (line === undefined) return file;
    if (Number.isInteger(f.end_line) && f.end_line && f.end_line > line) {
        return `${file}:${line}-${f.end_line}`;
    }
    return `${file}:${line}`;
}

/** Bounds the path by itself, so the cut takes path characters and leaves the line number. */
function boundedPath(file: string): string {
    const { kept, marker } = clampTo(flatten(file), MAX_PATH);

    return marker === "" ? kept : `${kept}…`;
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

    // Location first, then the title, matching `bullet`. The two render the same two fields
    // for the same kind of object, and a reader moving between the listing and this one was
    // reading them in opposite orders.
    return `- ${code(where(f))}: ${title(f)}${url}`;
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
 * Cut, escaped, then the marker, in the order and for the reasons `oneLine` gives. This is
 * the field the code-span defect bit hardest: a lens caveat is prose quoting fragments with
 * spaces in them, such as `@media (prefers-reduced-motion: reduce)`, and it renders inside the
 * lens block, where a stray opener runs on into the next lens's line.
 *
 * The line starts at the item's own content column, where a `#` or a `>` opens a block of
 * its own, and `escapeInline` leaves both alone.
 *
 * The cut-then-escape-then-marker ordering is `oneLine`'s, applied here through the same
 * function rather than copied: the policy is stated once and every caller of either gets it
 * identically.
 */
function lensDetail(detail: string): string {
    return `\n\n  ${oneLine(detail, MAX_LENS_DETAIL)}`;
}

/**
 * Whether a finding the length cut dropped rates above one it printed.
 *
 * The listing is ordered worst-first and `cutToFit` in body-budget.ts skips rather than stops,
 * so the findings on the page can be findings 1, 2, 4 and 5 with the third missing. Nothing else
 * on the page would say so: `bullet` prints no tier, and the heading names the bar the section
 * was filtered on rather than what survived the budget.
 */
function outranksPrinted(items: Finding[], kept: Finding[]): boolean {
    const shown = new Set(kept);
    const dropped = items.filter((f) => !shown.has(f));

    if (dropped.length === 0 || kept.length === 0) return false;

    return Math.min(...dropped.map(findingRank)) < Math.max(...kept.map(findingRank));
}

/**
 * Everything about this posting that is not the findings themselves.
 *
 * `RunFacts` is the half print-findings.ts reads too, so the coverage both renderers describe
 * is derived from one shape by one function.
 */
export interface Posting extends RunFacts {
    /** What became of the threads the orchestrator asked to close, which the body reports. */
    resolved: Array<{ reason: string }>;
    /** Whether the token could not close a thread, which picks the sentence the body prints. */
    resolveDenied: boolean;
    /** How many threads judged finished are still open, for whatever reason. */
    leftOpen: number;
    to: Destination;
    /** Every comment url the pull request carries, which is what `mention` may link. */
    linkable: ReadonlySet<string>;
    /** The lowest tier the body prints in full, where there is somewhere else to read the rest. */
    threshold: Tier;
}

/** A body and the two views of the run it was built from, for the caller that posts it. */
export interface Composed {
    body: string;
    /** The findings the body printed in full, with whatever did not fit dropped. */
    listed: Finding[];
    /**
     * Whether the body says anything about its own coverage or its own posting that a reader
     * has to see.
     *
     * The one thing a run with nothing new must not swallow. Zero findings and a lens that
     * never reported is the shape of a review that did not happen, and posting nothing leaves
     * the pull request reading as clean. Every notice is composed here, so a caller deciding
     * for itself would answer for some of the conditions and post a clean pull request on the
     * rest.
     *
     * Every notice raised counts, rather than the ones styled as warnings. A run raises one
     * only when it has something to say about how much of the change it covered, and none of
     * those is one a reader may be denied: the sentence about a lens that could not render the
     * page is the whole of what a green tick would otherwise be read as denying. Selecting on
     * `level` cost that sentence exactly the runs it was written for, the quiet ones.
     */
    warned: boolean;
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
    const coverage = coverageOf(merged, posting, parts);
    const raised = noticesFor(coverage);
    const aboutPosting = postingNotices(posting);

    const { listing, notice } = listingOf(parts.fresh, posting.to, posting.threshold);
    const tail = tailOf(merged, parts, posting, aboutPosting);

    const { body, printed } = assemble(
        headOf(merged, parts, coverage, raised),
        listing,
        notice === null ? tail : [notice, ...tail],
    );

    // Any notice a run raises, whatever `level` renders it as. `level` is styling.
    //
    // Filtering to warnings made this false on the case it exists for. `limited` is a note, and
    // it is the sentence saying what a lens could not check, so a first review over markup that
    // found no critical defect posted nothing at all and the reader took contrast, focus order,
    // target size and reflow for checked. Silence has to mean nothing was worth saying.
    //
    // The consequence, weighed and accepted on 2026-09-05: the shipped lens set always raises
    // `limited`, because three of its lenses have no browser and say so, so `warned` is always
    // true and `post-review.ts`'s post-nothing branch cannot fire. Every push posts. That
    // branch is not dead code to delete — a set excluding those lenses reaches it — and the
    // repeated comment is the cost this repository already accepts elsewhere for the same
    // trade, where a repeated comment costs less than a finding nobody sees. What would buy
    // back the quiet is saying the standing caveats only where no earlier review is still
    // carrying them, which needs a signal for that. "`lens_health` covers every lens dispatched"
    // in review/DECISIONS.md has the rest.
    const warned = raised.length > 0 || aboutPosting.length > 0;

    return { body, listed: printed, warned };
}

/**
 * GitHub's alert markup for one of the run's own notices, coverage or posting alike.
 *
 * `escapeInline` around every stretch that came from a model or from GitHub, and around
 * nothing else: the fixed prose carries backticks of its own that a general escape would put
 * on the page as backslashes.
 *
 * `escapeBlockStart` around the finished sentence, because `> ` is the blockquote's content
 * column and `escapeInline` leaves `#` and `>` alone by design. `silent` starts with lens names
 * read out of a file the review session can write, so one named `# foo` opened an h1 inside the
 * alert, in a body whose own headings start at h2. Here rather than in each notice, so that
 * nobody adding a sentence later has to remember it; every notice is one line by construction,
 * so the escape sees the whole of what follows the `> `.
 */
function alertBlock<T>(notice: Notice<T>, subject: T): string {
    const level = notice.level === "note" ? "NOTE" : "WARNING";

    return `> [!${level}]\n> ${escapeBlockStart(notice.say(subject, escapeInline))}`;
}

/**
 * What the body says about this posting rather than about its coverage, in the order a reader
 * meets it.
 *
 * A `Notice<Posting>` table, the same shape as `COVERAGE_NOTICES`, a `Notice<Coverage>` table:
 * the union comes from this list, the record below fails to compile until a new member has a
 * sentence, and `warned` counts what the record raised rather than a boolean restated beside
 * it. `threadsLeftOpen` was keyed off the permission denial rather than off the fact, so a
 * thread left open by a stale node id or a transient GraphQL error went to stderr and nowhere
 * a reader of the pull request would find it.
 *
 * Anything else the body has to say about its own posting belongs here beside it, rather than as
 * an `if` in `tailOf` and a second reading of the same condition in `warned`.
 */
const POSTING_ORDER = ["threadsLeftOpen"] as const;

type PostingAlert = (typeof POSTING_ORDER)[number];

const POSTING_NOTICES: Record<PostingAlert, Notice<Posting>> = {
    threadsLeftOpen: {
        level: "warning",
        raised: (p) => p.leftOpen > 0,
        say: (p) =>
            p.resolveDenied
                ? `${plural(p.leftOpen, "thread")} judged finished could not be resolved:` +
                  " the workflow grants `pull-requests: write`, and `resolveReviewThread` needs `contents: write`."
                : `${plural(p.leftOpen, "thread")} judged finished could not be closed.` +
                  " The job log names each one and what GitHub said.",
    },
};

/** The ones this posting raises, in the order above. */
function postingNotices(posting: Posting): PostingAlert[] {
    return raisedIn(POSTING_ORDER, POSTING_NOTICES, posting);
}

/**
 * Everything above the findings: the summary, the counts, and what the run says about its
 * own coverage.
 *
 * The notices come out of `COVERAGE_NOTICES` in the order it declares, rather than as a
 * branch each. Written by hand they were seven separate `if`s, and the union that decides
 * `warned` had grown one they did not cover: a run could raise a notice, decide on the
 * strength of it that the review was worth posting, and post a body that said nothing about
 * why.
 */
function headOf(merged: Merged, parts: Partitioned, coverage: Coverage, raised: CoverageAlert[]): string[] {
    const { health, broken } = coverage;
    const { fresh, suppressed, declined } = parts;

    const counts = [`**${plural(fresh.length, "new finding")}**`];
    if (suppressed.length > 0) counts.push(`${suppressed.length} raised in an earlier review`);
    if (declined.length > 0) counts.push(`${declined.length} raised before and declined`);

    const head: string[] = ["## CodeFerret"];

    if (merged.summary) head.push(prose(merged.summary, MAX_PROSE));

    // A screen reader speaks a separator between joined counts as nothing, so three of them
    // run into each other. Past one, they are a list.
    const [onlyCount] = counts;
    head.push(counts.length === 1 && onlyCount ? onlyCount : counts.map((c) => `- ${c}`).join("\n"));

    // The alert syntax is what the job summary uses for the same class of warning. What a lens
    // could not check is the one thing here a reader has to see without opening anything: a
    // reader takes a review of an interface change for an accessibility pass unless something
    // names the criteria nothing evaluated.
    for (const name of raised) head.push(alertBlock(COVERAGE_NOTICES[name], coverage));

    // Nothing to list, and the notice above has already said so.
    if (raised.includes("unaccounted")) return head;

    // A list, not a table: GitHub gives a wide column the container and starves the rest, and
    // most lenses report no detail at all. Punctuation a screen reader speaks, for the reason
    // the counts above are a list.
    const items = health.map((h) => {
        const name = oneLine(lensLabel(h.lens), MAX_LENS_NAME);
        const flag = h.ok ? "" : ", **needs attention**";
        const caveat = caveatOf(h);
        const detail = caveat ? lensDetail(caveat) : "";

        // The colon separates the name from its count, so the one bold left in the list is the
        // exception a reader has to see.
        return `- ${name}: ${plural(h.findings_returned, "finding")}${flag}${detail}`;
    });

    const heading = raised.includes("broken")
        ? `${lenses(health.length)} ran, ${broken.length} needing attention`
        : `${lenses(health.length)} ran, all reporting`;

    // Open when a lens named a limit, not only when one broke. The note above says "the list
    // below has each in its own words", and a `<details>` a reader has to click is not below
    // anything: the sentence promised the words and then hid them.
    head.push(
        details(
            heading,
            boundedBlock(items, MAX_LENS_BLOCK, lenses),
            raised.includes("broken") || raised.includes("limited"),
        ),
    );

    return head;
}

/**
 * How much one of the tail's lists may spend before it says what it left out.
 *
 * `assemble` charges the whole tail against the budget before it measures a single finding
 * bullet, on the stated premise that everything but the listing is short. These lists were the
 * exception: one line per suppressed finding, per declined finding and per resolved thread, and
 * a long-lived pull request accumulates all of them. Unbounded they push the budget negative
 * before the first bullet, so the findings section renders as a heading over nothing but its own
 * omission line, and `fit` then cuts from the end, which is where the caveats are.
 *
 * A count is the wrong measure for that, and forty items was the bound these carried. A
 * `mention` is a path and a title, both of them model-written, plus a link to a comment: forty
 * of each comes to around 12k of a 60k body at a hundred characters a line, and to several times
 * that at the lengths `MAX_PATH` and `MAX_TITLE` allow, so the 12k the budget was reasoned about
 * is not the space it got. A budget in characters is what that reasoning assumed all along, and
 * four thousand per list holds the tail to what the old note claimed for it.
 *
 * The count above each block stays the true one: it is the `<details>` heading, which is built
 * from the whole list.
 */
const MAX_MENTION_BLOCK = 4000;

/**
 * How much the head's lens block may spend, which is more than a tail list gets.
 *
 * `lensDetail` allows each lens up to `MAX_LENS_DETAIL`, so a dozen lenses answering in full is
 * a head section larger than most whole reviews. `assemble` charges the head against `MAX_BODY`
 * before it measures a single finding, so what a lens said about itself would push out the
 * findings a reader came for.
 *
 * This block is also the review's only per-lens channel: it carries the `needs attention` flag
 * for a lens that broke and the standing sentence for one shipping without the capability its
 * skill describes.
 */
const MAX_LENS_BLOCK = 12_000;

function furtherFindings(n: number): string {
    return plural(n, "further finding");
}

/**
 * Everything below the findings: what was suppressed, what was declined, what was closed,
 * and the run's own caveats.
 */
function tailOf(merged: Merged, parts: Partitioned, posting: Posting, aboutPosting: PostingAlert[]): string[] {
    const { suppressed, declined } = parts;
    const { resolved, linkable } = posting;

    const tail: string[] = [];

    if (suppressed.length > 0) {
        tail.push(
            details(
                `${plural(suppressed.length, "finding")} raised in an earlier review`,
                boundedBlock(
                    suppressed.map((f) => mention(f, "earlier comment", linkable)),
                    MAX_MENTION_BLOCK,
                    furtherFindings,
                ),
            ),
        );
    }

    if (declined.length > 0) {
        tail.push(
            details(
                `${plural(declined.length, "finding")} raised before and declined`,
                boundedBlock(
                    declined.map((f) => mention(f, "thread", linkable)),
                    MAX_MENTION_BLOCK,
                    furtherFindings,
                ),
            ),
        );
    }

    if (resolved.length > 0) {
        tail.push(
            details(
                `${plural(resolved.length, "thread")} resolved`,
                boundedBlock(
                    resolved.map((r) => `- ${oneLine(r.reason, MAX_TITLE)}`),
                    MAX_MENTION_BLOCK,
                    (n) => plural(n, "further thread"),
                ),
            ),
        );
    }

    for (const name of aboutPosting) tail.push(alertBlock(POSTING_NOTICES[name], posting));

    if (merged.notes) tail.push(`### Caveats\n\n${prose(merged.notes, MAX_PROSE)}`);

    return tail;
}

/**
 * The findings section, or the line that stands in for it.
 *
 * `notice` is what a run with findings but nothing worth listing says instead. It goes at
 * the top of the tail rather than under a heading of its own, because a heading is a promise
 * of something under it and the count is already above.
 *
 * `assemble` bounds the listing whichever branch this takes, and says how many findings did
 * not fit. `offered` is what the section leads with, so it stays the count the lead sentence
 * quotes; what came back out of `assemble` is what `Composed.listed` reports.
 *
 * Exported for review-body.test.ts, which pairs it with `assemble` to reach the omission line
 * over a body long enough to overflow. Nothing else outside this module calls it.
 */
export function listingOf(
    fresh: Finding[],
    to: Destination,
    threshold: Tier,
): { listing: Listing<Finding> | null; notice: string | null } {
    const offered = listedIn(fresh, to, threshold);
    const artifact = artifactUrl(to);

    if (offered.length > 0) {
        const rest = omissionFor(to);

        return {
            listing: {
                heading: artifact ? listingHeading(threshold) : "Findings",
                lead: artifact ? `${offered.length} of ${plural(fresh.length, "finding")}. ${artifactSentence(artifact)}` : "",
                items: offered,
                render: bullet,
                // The budget knows only how many it dropped, so the clause `outranksPrinted`
                // decides has to be worded here.
                omitted: (missing, shown) =>
                    `${plural(missing, "further finding")} left out for length` +
                    `${outranksPrinted(offered, shown) ? ", one of them rated above a finding printed here" : ""}.` +
                    ` ${rest}`,
            },
            notice: null,
        };
    }

    if (fresh.length > 0 && artifact) {
        return { listing: null, notice: `Nothing rates ${threshold} or above. ${artifactSentence(artifact)}` };
    }

    return { listing: null, notice: null };
}

/**
 * Where every finding is, for the two branches above that have somewhere to send a reader.
 *
 * Both names come from the constants that own them. `ARTIFACT_NAME` is generated from
 * `action.yml`, and `fetch-previous.ts` opens the artifact by it, so a rename there moved the
 * code that reads the artifact and left this sentence sending a reader to download one that no
 * longer exists, with nothing red: the generator check compares the constant against
 * `action.yml` and never against a sentence.
 */
function artifactSentence(url: string): string {
    return `\`${FINDINGS_FILE}\` in the \`${ARTIFACT_NAME}\` artifact of [this run](${url}) holds every one.`;
}

/**
 * Where to read a finding the listing had no room for.
 *
 * The `run` branch used to send the reader to the job log. Nothing prints a finding there:
 * extract-findings.ts logs counts, costs and lens health, check-findings.ts logs repairs, and
 * print-findings.ts is only ever run by local-print.sh. The findings file is written under
 * `$RUNNER_TEMP` and torn down with the runner, so on that configuration the rest were kept
 * nowhere, and the sentence has to say so rather than cost a reader a trip through a
 * twenty-minute log.
 */
function omissionFor(to: Destination): string {
    switch (to.kind) {
        case "artifact":
            return "Every one of them is in the findings file.";
        case "run":
            return `This run kept no artifact, so the rest were kept nowhere. Set \`artifact-path\` to \`${FINDINGS_FILE}\`.`;
        case "session":
            return "This review was posted from a session, so ask whoever ran it for the rest.";
    }
}

/**
 * Names the section after the bar `isPrinted` applied, not after the tiers that ended up in it.
 *
 * `bullet` prints no tier, so the heading is the reader's only account of what was left out. A
 * heading built from the findings present would rename the section every run, and a reader
 * takes a page headed for the worst tier in it as a promise that nothing lower was found.
 */
function listingHeading(threshold: Tier): string {
    return `Findings rated ${threshold} and above`;
}
