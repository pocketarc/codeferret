/**
 * The rendering a posted review is built from.
 *
 * Every function here is pure over strings and JSON, and each one has a failure mode
 * nothing downstream would report: markdown a model did not mean to write renders as
 * debris, and a budget that goes negative drops the findings the body exists to carry. What
 * a run produced is in `findings.ts`; what a character does to markdown is in
 * `markdown.ts`.
 */

import { brokenLenses, isListed, lensLabel, LISTED, silentLenses } from "./findings.ts";
import type { Finding, LensHealth, Merged, Partitioned, Vetted } from "./findings.ts";
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

/**
 * Why suppressions were reopened, in the words a reader gets, one line per kind that applies.
 *
 * Here for the reason `caveatOf` is: `Vetted` is findings.ts's shape and these are sentences,
 * which that module keeps out on purpose. Written out at the posting path alone, they were
 * four copies of one `if (n > 0) console.error(...)`, and `print-findings.ts` ran the same
 * vetting and printed none of them, so a session reopened a suppression in silence while a
 * posted run explained it.
 *
 * The second line is counted apart from the first because it is the half of the rule a
 * maintainer feels: a decline they meant, reopened because the comment behind it named
 * nothing.
 */
export function reopenedReasons(vetted: Vetted): string[] {
    const cases: Array<[number, string]> = [
        [
            vetted.untraceable,
            `${plural(vetted.untraceable, "decline")} cited no comment from an owner, member or collaborator,` +
                " and no resolved thread. Reporting them as new.",
        ],
        [
            vetted.unrelated,
            `${plural(vetted.unrelated, "decline")} cited a comment that says nothing about the file the` +
                " finding is in. Reporting them as new.",
        ],
        [
            vetted.unreported,
            `${plural(vetted.unreported, "finding")} came back as already raised, citing a comment that is not` +
                " on this pull request or says nothing about the file. Reporting them as new.",
        ],
        [
            vetted.unmatched,
            `${plural(vetted.unmatched, "finding")} came back as already raised, citing no comment and naming a` +
                " file the previous review did not. Reporting them as new.",
        ],
    ];

    return cases.filter(([count]) => count > 0).map(([, said]) => said);
}

// The orchestrator writes both the summary and the notes, and nothing bounds what a model
// produces. Left unbounded, a runaway summary eats the length the findings need.
export const MAX_PROSE = 4000;

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
export const MAX_FINDING_BODY = 4000;

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
 *
 * Exported because post-review.ts logs this count beside the ones `partition` gives it,
 * and a log line that contradicts the body it describes is worse than no log line.
 */
export function listedIn(fresh: Finding[], to: Destination): Finding[] {
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
    const body = escapeBlocks(closeOpenFence(clamp(f.body, MAX_FINDING_BODY)).split("\n")).join("\n  ");

    // Flattened for the reason `title` is: the field is asked for as one line and checked
    // only for being a string, and a newline in it ends the list item, putting whatever
    // follows at column zero where a `#` opens a heading in the middle of the review.
    // Checked for being a string as well, because the rule that keeps a finding with a bad
    // category tolerates whatever the model sent: a number here reaches `escapeInline`,
    // comes back empty, and leaves a bare `__` on a line of its own.
    //
    // check-findings.ts keeps a finding whose category is missing rather than dropping it,
    // so this line is omitted. Rendering it anyway puts the word "undefined" under the body.
    const label = typeof f.category === "string" ? escapeInline(flatten(f.category)) : "";
    const category = label === "" ? "" : `\n\n  _${label}_`;

    return `- ${code(where(f))}: **${title(f)}**\n\n  ${body}${category}`;
}

/**
 * A model's one-line field, as one bounded line safe at a list item's content column.
 *
 * Escaped before the cut, for the reason `lensDetail` gives: the marker `clamp` appends is
 * markdown of its own and must not be escaped and shown as underscores. Flattened again
 * after it, because that marker carries newlines, and one inside `bullet`'s strong emphasis
 * closes it and leaves a literal `**` on the page.
 *
 * `escapeBlockStart` because `mention` and the resolved list both put one of these where a
 * `- ` item's content starts, and `escapeInline` leaves `#` and `>` alone: a title of
 * `# Fix the parser` rendered an h1 in the middle of the suppressed list. Inside `bullet`
 * the same string sits between two asterisks where neither opens anything, and the escape
 * costs a backslash the renderer takes back off.
 */
function oneLine(text: string, limit: number): string {
    return flatten(clamp(escapeBlockStart(escapeInline(flatten(text))), limit));
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
 * Some lenses ship without the capability their skills describe, and every step that would
 * carry that as far as the reader is a soft one: the lens is asked to write its limits down,
 * and the orchestrator to copy them into `detail`. Either can forget, and then a pull request full
 * of interface changes comes back looking as though its accessibility had been checked,
 * which is the failure `review/lens-extras/anthropic-accessibility-review.md` exists to
 * prevent. A standing sentence is worse than the lens's own words and cannot be forgotten.
 *
 * The rule for what belongs here: a lens whose `review/lens-extras/<lens>.md` opens by
 * naming a capability the session does not have gets a sentence saying so. Written down
 * because this map and that file are edited apart, and a lens left out of the map is the one
 * whose gap nothing reports.
 *
 * The sentence has to keep saying what that file rules out, and the two have drifted before:
 * this one said motion was unevaluated while the brief puts the source half of 2.2.2 and
 * 2.3.3 in scope, so a review that carried a lens's finding about motion also said motion was
 * not evaluated. `validate-repo.ts` checks that every key here has a brief and nothing more;
 * the words are a reading.
 */
export const STANDING_DETAIL: ReadonlyMap<string, string> = new Map([
    [
        "anthropic-accessibility-review",
        "No page was rendered, so contrast, focus order, target size, reflow, text spacing," +
            " timing limits and what an assistive technology announces were not evaluated.",
    ],
    ["copilot-web-design-reviewer", "No browser was available, so nothing was judged from a rendered page."],
    [
        "vercel-next-best-practices",
        "No application was running, so nothing was judged from a build, a bundle or a rendered page.",
    ],
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

/** The joined body, and which findings actually reached it. */
export interface Assembled {
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
    /**
     * What the comment fetch could not read, from `unreadOf`.
     *
     * A half-failed fetch reopens every suppression resting on the half that did not come
     * back, which is the safe direction and looks to a reader like a review repeating
     * findings they already answered. The job log carries it and the person the caveats are
     * for never opens the job log.
     */
    unread: string[];
    /**
     * The lenses this run dispatched, from the list build-prompts.sh wrote.
     *
     * The body's whole account of coverage is otherwise the orchestrator's own `lens_health`,
     * and an entry it left out takes three things with it at once: the lens goes from the
     * list, the heading calls a smaller set "all reporting", and its `STANDING_DETAIL`
     * sentence never reaches the body, so a pull request full of interface changes comes back
     * as though the interface had been reviewed.
     */
    dispatched: string[];
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
    const health = merged.lens_health ?? [];
    const broken = brokenLenses(health);
    const silent = silentLenses(
        health.map((h) => h.lens),
        posting.dispatched,
    );

    const { listing, notice } = listingOf(parts.fresh, posting.to);
    const tail = tailOf(merged, parts, posting);

    const { body, printed } = assemble(
        headOf(merged, parts, health, broken, silent, posting.unread),
        listing,
        notice === null ? tail : [notice, ...tail],
    );

    // Every condition under which something below writes a `[!WARNING]`. An empty
    // `lens_health` is one of them on its own: with no dispatch list to compare against,
    // `silent` is empty too, and a run that accounted for none of its lenses would read as
    // one with nothing to declare.
    const warned =
        health.length === 0 ||
        broken.length > 0 ||
        silent.length > 0 ||
        posting.unread.length > 0 ||
        posting.resolveDenied;

    return { body, listed: printed, warned };
}

/**
 * Everything above the findings: the summary, the counts, and what the run says about its
 * own coverage.
 */
function headOf(
    merged: Merged,
    parts: Partitioned,
    health: LensHealth[],
    broken: LensHealth[],
    silent: string[],
    unread: string[],
): string[] {
    const { fresh, suppressed, declined } = parts;

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

    // Above the lens block, because it is about the counts directly above it rather than
    // about coverage of the diff: a finding this review repeats is one whose answer went
    // unread, and without this the reader has only the repetition to go on.
    if (unread.length > 0) {
        head.push(
            `> [!WARNING]\n> Part of the discussion on this pull request could not be read, so anything answered` +
                ` there is raised again: ${escapeInline(flatten(unread.join(" ")))}`,
        );
    }

    if (health.length === 0) {
        // Everything a reader has for how much of this review to trust hangs off
        // `lens_health`: the lens list, the coverage alert, and the standing sentence for a
        // lens that ships without the capability its skill describes. `lens_health` is
        // optional to the model, so one omitted array takes all of it out at once, and a
        // body that stops mentioning lenses reads as a review with nothing to declare.
        // check-findings.ts writes a warning to the job log, which the person the caveats are
        // for never opens.
        head.push(
            "> [!WARNING]\n> This run reported nothing about which lenses ran or what they could not check," +
                " so how much of the change was covered is unknown.",
        );
    } else {
        // A list, not a table: GitHub gives a wide column the container and starves the
        // rest, and most lenses report no detail at all. Punctuation a screen reader speaks,
        // for the reason the counts above are a list.
        const items = health
            .map((h) => {
                // Flattened for the reason `lensDetail` beside it is: a newline in a name
                // the model wrote ends this item, and the rest of the lens list then lands
                // outside the block it belongs to.
                const name = escapeInline(flatten(lensLabel(h.lens)));
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
        //
        // A lens missing from `lens_health` comes first, because the two counts under it are
        // both drawn from that same list and so fall short by exactly the lenses named here.
        if (silent.length > 0) {
            head.push(
                `> [!WARNING]\n> ${escapeInline(silent.join(", "))} ran and reported nothing about` +
                    " themselves, so the coverage below leaves each one out.",
            );
        }

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
function tailOf(merged: Merged, parts: Partitioned, posting: Posting): string[] {
    const { suppressed, declined } = parts;
    const { resolved, resolveDenied, leftOpen, linkable } = posting;

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

    if (resolveDenied) {
        tail.push(
            `> [!WARNING]\n> ${plural(leftOpen, "thread")} judged finished could not be resolved:` +
                ` the workflow grants \`pull-requests: write\`, and \`resolveReviewThread\` needs` +
                ` \`contents: write\`.`,
        );
    }

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
