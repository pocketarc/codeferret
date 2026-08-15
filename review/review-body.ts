/**
 * The rendering a posted review is built from.
 *
 * Every function here is pure over strings and JSON, and each one has a failure mode
 * nothing downstream would report: markdown a model did not mean to write renders as
 * debris, and a budget that goes negative drops the findings the body exists to carry. What
 * a run produced is in `findings.ts`; what a character does to markdown is in `markdown.ts`;
 * what the run says about itself, in the words a printed review uses too, is in `caveats.ts`.
 */

import { caveatOf, COVERAGE_NOTICES, coverageOf, noticesFor } from "./caveats.ts";
import type { Coverage, CoverageAlert, Notice, RunFacts } from "./caveats.ts";
import { isListed, lensLabel, lineOf, LISTED } from "./findings.ts";
import type { Finding, Merged, Partitioned } from "./findings.ts";
import { lenses, plural } from "./words.ts";
import {
    clamp,
    clampTo,
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
    splitLines,
} from "./markdown.ts";

/**
 * GitHub's limit on a review body is 65536 characters. The difference is headroom.
 *
 * Exported for review-body.test.ts, which builds a body against the limit rather than
 * against a number typed out beside it. Nothing else outside this module reads it.
 */
export const MAX_BODY = 60000;

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
 * Where this review is being posted. `listedIn` reads it to bound what the body carries.
 *
 * Three states and three variants. As two variants and an `artifact` boolean, no reader read
 * the boolean: each folded it back into "is there a run holding the rest" and then asked
 * `kind` as well to tell the remaining two apart, so the one question took two answers.
 */
export type Destination =
    | { kind: "artifact"; url: string }
    | { kind: "run"; url: string }
    | { kind: "session" };

/**
 * Which of the three this run is.
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

    const url = `${server}/${repo}/actions/runs/${id}`;

    return env.ARTIFACT_HAS_FINDINGS === "true" ? { kind: "artifact", url } : { kind: "run", url };
}

/**
 * The findings the body prints in full.
 *
 * With an artifact behind it the body prints the severities a reader should stop for and
 * names that artifact for the rest, because it is one download away for everybody reading
 * the pull request. With nothing behind it (a session, whose findings file is a path under
 * `.git/` on one person's machine, or a run that kept no artifact) every finding goes in the
 * body instead, since there is nowhere else to read it.
 */
function listedIn(fresh: Finding[], to: Destination): Finding[] {
    return to.kind === "artifact" ? fresh.filter(isListed) : fresh;
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
    const label = typeof f.category === "string" ? escapeInline(f.category) : "";
    const category = label === "" ? "" : `\n\n  _${label}_`;

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

    if (line === undefined) return f.file;
    if (Number.isInteger(f.end_line) && f.end_line && f.end_line > line) {
        return `${f.file}:${line}-${f.end_line}`;
    }
    return `${f.file}:${line}`;
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
 */
function lensDetail(detail: string): string {
    const { kept, marker } = clampTo(flatten(detail), MAX_LENS_DETAIL);

    return `\n\n  ${flatten(`${escapeBlockStart(escapeInline(kept))}${marker}`)}`;
}

/** The joined body, and which findings actually reached it. */
interface Assembled {
    body: string;
    /**
     * The findings whose bullets went in.
     *
     * The set offered to the listing is not the set printed: a finding too long for what is
     * left is skipped, and nothing outside `assemble` can tell which ones went. `post-review.ts`
     * logs this count as what the body carried, and a log line that contradicts the body it
     * describes is worse than no log line.
     */
    printed: Finding[];
}

/** A heading, a reason, and findings listed under it. The one section that can run long. */
interface Listing {
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
 *
 * Exported for review-body.test.ts. `composeReview` is what a run calls, and the cutting is
 * the part with cases worth writing down one by one.
 */
export function assemble(head: string[], listing: Listing | null, tail: string[]): Assembled {
    let budget = MAX_BODY - [...head, ...tail].reduce((total, s) => total + s.length + 2, 0);

    const rendered = [...head];
    const printed: Finding[] = [];

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
            printed.push(finding);
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
}

/** A body and the two views of the run it was built from, for the caller that posts it. */
export interface Composed {
    body: string;
    /** The findings the body printed in full, with whatever did not fit dropped. */
    listed: Finding[];
    /**
     * Whether the body says anything about its own coverage that a reader has to see.
     *
     * The one thing a run with nothing new must not swallow. Zero findings and a lens that
     * never reported is the shape of a review that did not happen, and posting nothing leaves
     * the pull request reading as clean. Every warning is composed here, so a caller deciding
     * for itself would answer for some of the conditions and post a clean pull request on the
     * rest.
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
    const coverage = coverageOf(merged, posting);
    const raised = noticesFor(coverage);
    const aboutPosting = postingNotices(posting);

    const { listing, notice } = listingOf(parts.fresh, posting.to);
    const tail = tailOf(merged, parts, posting, aboutPosting);

    const { body, printed } = assemble(
        headOf(merged, parts, coverage, raised),
        listing,
        notice === null ? tail : [notice, ...tail],
    );

    // A `note` does not force a post on its own. `limited` is one, and on the shipped lens
    // set it is permanent: three lenses have no browser today and every run says so, whatever
    // the diff. Counting it here made `warned` true on every run, which made the "nothing new,
    // post nothing" branch in post-review.ts unreachable — a quiet pull request got a fresh
    // "0 new findings" comment on every push, which is the exact noise that branch exists to
    // stop. A `warning` is news about this run and still forces a post; a standing `note` does
    // not, though it still renders whenever the body posts for some other reason.
    const warnings = raised.filter((name) => COVERAGE_NOTICES[name].level === "warning");

    return { body, listed: printed, warned: warnings.length > 0 || aboutPosting.length > 0 };
}

/**
 * GitHub's alert markup for one of the run's own notices.
 *
 * `escapeInline` around every stretch that came from a model or from GitHub, and around
 * nothing else: the fixed prose carries backticks of its own that a general escape would put
 * on the page as backslashes.
 */
function alertBlock(notice: Notice, coverage: Coverage): string {
    const level = notice.level === "note" ? "NOTE" : "WARNING";

    return `> [!${level}]\n> ${notice.say(coverage, escapeInline)}`;
}

/**
 * What the body says about this posting rather than about its coverage, in the order a reader
 * meets it.
 *
 * Written the way `caveats.ts` writes a coverage notice, and for the reason it gives: the
 * union comes from this list, the record below fails to compile until a new member has a
 * sentence, and `warned` counts what the record raised rather than a boolean restated beside
 * it. `threadsLeftOpen` was keyed off the permission denial rather than off the fact, so a
 * thread left open by a stale node id or a transient GraphQL error went to stderr and nowhere
 * a reader of the pull request would find it.
 */
const POSTING_ORDER = ["threadsLeftOpen"] as const;

type PostingAlert = (typeof POSTING_ORDER)[number];

const POSTING_NOTICES: Record<PostingAlert, { raised: (p: Posting) => boolean; say: (p: Posting) => string }> = {
    threadsLeftOpen: {
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
    return POSTING_ORDER.filter((name) => POSTING_NOTICES[name].raised(posting));
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
        const name = escapeInline(lensLabel(h.lens));
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
    head.push(details(heading, boundedBlock(items, "lens"), raised.includes("broken") || raised.includes("limited")));

    return head;
}

/**
 * How many lines one of the tail's three lists prints before it says what it left out.
 *
 * `assemble` charges the whole tail against the budget before it measures a single finding
 * bullet, on the stated premise that everything but the listing is short. These three were
 * the exception: one line per suppressed finding, per declined finding and per resolved
 * thread, and a long-lived pull request accumulates all three. Unbounded they push the budget
 * negative before the first bullet, so the findings section renders as a heading over nothing
 * but its own omission line, and `fit` then cuts from the end, which is where the caveats are.
 *
 * Forty of each at roughly a hundred characters a line is around 12k of a 60k body, which
 * leaves the listing the rest. The count above each block stays the true one: it is the
 * `<details>` heading, which is built from the whole list.
 */
const MAX_MENTIONS = 40;

/**
 * The head's lens block, cut to a length rather than a count.
 *
 * Every other bounded list here is bounded by how many items it holds, and that is the wrong
 * measure for this one: `lensDetail` already allows each lens up to `MAX_LENS_DETAIL`, so a
 * dozen lenses answering in full is a head section larger than most whole reviews. `assemble`
 * charges the head against `MAX_BODY` before it measures a single finding, so what a lens
 * said about itself would push out the findings a reader came for.
 *
 * A lens too long for what is left costs only its own line, which is `assemble`'s rule for
 * findings and holds harder here. This block is the review's only per-lens channel: it
 * carries the `needs attention` flag for a lens that broke and the standing sentence for one
 * shipping without the capability its skill describes. Stopping at the first verbose lens
 * would drop every lens after it while the alerts above went on counting the whole list.
 */
const MAX_LENS_BLOCK = 12_000;

function boundedBlock(items: string[], noun: string): string {
    const kept: string[] = [];
    let used = 0;

    for (const item of items) {
        if (used + item.length + 1 > MAX_LENS_BLOCK) continue;

        kept.push(item);
        used += item.length + 1;
    }

    if (kept.length === items.length) return kept.join("\n");

    return [...kept, `- _${plural(items.length - kept.length, `further ${noun}`)} left out for length._`].join("\n");
}

/** One of those lists, cut to `MAX_MENTIONS` with a line saying how many went. */
function bounded(items: string[], noun: string): string {
    if (items.length <= MAX_MENTIONS) return items.join("\n");

    const missing = items.length - MAX_MENTIONS;

    return [...items.slice(0, MAX_MENTIONS), `- _${plural(missing, `further ${noun}`)} left out for length._`].join(
        "\n",
    );
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
                bounded(
                    suppressed.map((f) => mention(f, "earlier comment", linkable)),
                    "finding",
                ),
            ),
        );
    }

    if (declined.length > 0) {
        tail.push(
            details(
                `${plural(declined.length, "finding")} raised before and declined`,
                bounded(
                    declined.map((f) => mention(f, "thread", linkable)),
                    "finding",
                ),
            ),
        );
    }

    if (resolved.length > 0) {
        tail.push(
            details(
                `${plural(resolved.length, "thread")} resolved`,
                bounded(
                    resolved.map((r) => `- ${oneLine(r.reason, MAX_TITLE)}`),
                    "thread",
                ),
            ),
        );
    }

    for (const name of aboutPosting) tail.push(`> [!WARNING]\n> ${POSTING_NOTICES[name].say(posting)}`);

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
 */
function listingOf(fresh: Finding[], to: Destination): { listing: Listing | null; notice: string | null } {
    const offered = listedIn(fresh, to);
    const artifact = to.kind === "artifact" ? to.url : null;

    if (offered.length > 0) {
        return {
            listing: {
                heading: artifact ? listingHeading(offered) : "Findings",
                lead: artifact
                    ? `${offered.length} of ${plural(fresh.length, "finding")}.` +
                      ` \`findings.json\` in the \`codeferret-run\` artifact of [this run](${artifact}) holds every one.`
                    : "",
                omission: omissionFor(to),
                items: offered,
            },
            notice: null,
        };
    }

    if (fresh.length > 0 && artifact) {
        return {
            listing: null,
            notice:
                `No finding is critical or high.` +
                ` \`findings.json\` in the \`codeferret-run\` artifact of [this run](${artifact}) holds every one.`,
        };
    }

    return { listing: null, notice: null };
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
            return "This run kept no artifact, so the rest were kept nowhere. Set `artifact-path` to `findings.json`.";
        case "session":
            return "This review was posted from a session, so ask whoever ran it for the rest.";
    }
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
