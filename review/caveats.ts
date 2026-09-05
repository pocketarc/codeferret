/**
 * What a run says about itself, in the words both renderers use.
 *
 * How much of the change the lenses covered, which suppressions were reopened and why, and
 * every warning either of those raises. A posted review and a printed one both draw on this,
 * and print-findings.ts used to rebuild most of the coverage facts by hand, some of them in
 * its own words. The copy had already drifted where it mattered: a session whose comment fetch
 * half-failed printed reopened findings with nothing saying the discussion was half read,
 * while a posted run explained it.
 *
 * Sentences only. What a character does to markdown is in `markdown.ts`, and how a body is
 * cut to fit is in `review-body.ts`.
 */

import { brokenLenses, lensLabel, silentLenses } from "./findings.ts";
import type { LensHealth, Merged, Reopening, Vetted } from "./findings.ts";
import { clampTo } from "./markdown.ts";
import { STANDING_DETAIL } from "./standing-detail.ts";
import { lenses, plural } from "./words.ts";

/**
 * Keyed by the counter rather than listed beside it. A `Record` over the counter names turns
 * a counter added to `Vetted` into a compile error here, where an array of pairs took the new
 * one, said nothing about it, and left a reader looking at a reopened finding with no line
 * explaining why it came back.
 *
 * Declared in the order a reader meets these reasons, which `REOPENING_ORDER` below reads off
 * this object rather than restating: reorder a property here and the reader-facing order moves
 * with it, on purpose, the same way it would for `COVERAGE_ORDER` or `POSTING_ORDER`.
 */
const REOPENING: Record<Reopening, (n: number) => string> = {
    untraceable: (n) =>
        `${plural(n, "decline")} cited no comment from an owner, member or collaborator,` +
        " and no resolved thread. A resolved thread settles only a finding this review does" +
        " not print in full. Reporting them as new.",
    unrelated: (n) =>
        `${plural(n, "decline")} cited a comment that says nothing about the file the` +
        " finding is in. Reporting them as new.",
    unvouched: (n) =>
        `${plural(n, "finding")} came back as already raised at a rating this review prints` +
        " in full, with no owner, member or collaborator having said so. Reporting them as new.",
    unreported: (n) =>
        `${plural(n, "finding")} came back as already raised, citing a comment that is not` +
        " on this pull request or says nothing about the file. Reporting them as new.",
    unmatched: (n) =>
        `${plural(n, "finding")} came back as already raised, citing no comment and naming a` +
        " file the previous review did not. Reporting them as new.",
};

/**
 * `REOPENING`'s own keys, read once rather than on every call.
 *
 * `COVERAGE_ORDER` and `POSTING_ORDER` are hand-written tuples because they are each the one
 * place their alert union is defined. `Reopening` is not defined here (it is
 * `Exclude<keyof Vetted, "findings">` in findings.ts), so a hand-written tuple here would be a
 * second list a counter added to `Vetted` could fall out of step with, silently dropping its
 * reason from the review. Reading the keys off `REOPENING` instead stays complete for free:
 * `REOPENING`'s own `Record<Reopening, ...>` annotation above already forces every reason to be
 * there before this line ever runs.
 */
const REOPENING_ORDER = Object.keys(REOPENING) as readonly Reopening[];

/**
 * Why suppressions were reopened, in the words a reader gets, one line per kind that applies.
 *
 * Here for the reason the coverage sentences below are: `Vetted` is findings.ts's shape and
 * these are sentences, which that module keeps out on purpose. Written out at the posting path
 * alone, they were four copies of one `if (n > 0) console.error(...)`, and `print-findings.ts`
 * ran the same vetting and printed none of them, so a session reopened a suppression in silence
 * while a posted run explained it.
 *
 * The second line is counted apart from the first because it is the half of the rule a
 * maintainer feels: a decline they meant, reopened because the comment behind it named
 * nothing.
 */
export function reopenedReasons(vetted: Vetted): string[] {
    return REOPENING_ORDER.filter((name) => vetted[name] > 0).map((name) => REOPENING[name](vetted[name]));
}

/**
 * What a run can say about how much of the change it covered, derived once.
 *
 * A bag rather than a parameter list: `silent` and `unread` are both `string[]`, so swapping
 * the two adjacent arguments still compiled, leaving a review that reported unread comments as
 * silent lenses. `finding-rules.ts` has the same move written down: adding to what a walk
 * carries is a field here rather than another argument threaded through every call.
 */
export interface Coverage {
    health: LensHealth[];
    /** The lenses that reported themselves as not having run normally. */
    broken: LensHealth[];
    /** The lenses that were dispatched and said nothing about themselves. */
    silent: string[];
    /** The lenses that named something they could not check, in their own words or a standing one. */
    limited: LensHealth[];
    /** The parts of the discussion the fetch could not read. */
    unread: string[];
    /** The build files the session changed under the run. */
    sessionChanged: string[];
}

/** What a run knows about itself that is not in its findings. */
export interface RunFacts {
    /**
     * The lenses this run dispatched, from the list build-prompts.sh wrote.
     *
     * The account of coverage is otherwise the orchestrator's own `lens_health`, and an entry
     * it left out takes three things with it at once: the lens goes from the list, the heading
     * calls a smaller set "all reporting", and its `STANDING_DETAIL` sentence never reaches a
     * reader, so a pull request full of interface changes comes back as though the interface
     * had been reviewed.
     */
    dispatched: string[];
    /** The build files the session changed under the run, from `readSessionChanged`. */
    sessionChanged: string[];
    /** What the comment fetch could not read, from `unreadOf`. */
    unread: string[];
}

/** The one derivation, so a posted review and a printed one cannot describe different runs. */
export function coverageOf(merged: Merged, facts: RunFacts): Coverage {
    const health = merged.lens_health ?? [];

    return {
        health,
        broken: brokenLenses(health),
        silent: silentLenses(
            health.map((h) => h.lens),
            facts.dispatched,
        ),
        limited: health.filter((h) => caveatOf(h)),
        unread: facts.unread,
        sessionChanged: facts.sessionChanged,
    };
}

/**
 * The standing sentence and the lens's own words together, or nothing where there is
 * neither.
 *
 * Both, rather than whichever is there. A lens told to report what it could not check
 * usually answers about the diff ("no markup or styles in it"), and that is a different fact
 * from having had no browser to look at one. Shown the first alone, a reader takes the
 * interface for looked at and unremarkable.
 *
 * Some lenses ship without the capability their skills describe, and every step that would
 * carry that as far as the reader is a soft one: the lens is asked to write its limits down,
 * and the orchestrator to copy them into `detail`. Either can forget, and then a pull request
 * full of interface changes comes back looking as though its accessibility had been checked.
 * A standing sentence is worse than the lens's own words and cannot be forgotten.
 *
 * `STANDING_DETAIL` is generated from the `standing-detail` frontmatter of each
 * `review/lens-extras/<lens>.md`, so the sentence and the brief that rules the capability out
 * cannot be edited apart. A `Map` rather than an object literal: a lens named `constructor` or
 * `toString` gets nothing back, where a literal would hand over an inherited function.
 */
export function caveatOf(h: LensHealth): string | undefined {
    const both = [STANDING_DETAIL.get(lensLabel(h.lens)), h.detail].filter((s) => s);

    return both.length > 0 ? both.join(" ") : undefined;
}

/**
 * How much of what the comment fetch could not read the sentence carries.
 *
 * Every other externally-derived string a review body puts on the page is bounded, and this
 * one was not. `unreadOf` hands back whatever `fetch-existing.ts` wrote, which for a GraphQL
 * failure is every message GitHub returned joined together. `assemble` charges the head
 * against the body's limit before it measures a single finding, so a long enough one takes the
 * findings section first and then pushes the body into the last-resort cut, which cuts from
 * the end, where the caveats are.
 */
const MAX_UNREAD = 500;

/** An escape for the stretch of a sentence that came from a model or from GitHub. */
export type Escape = (text: string) => string;

/**
 * One thing a run has to tell a reader, about its coverage or about the posting itself.
 *
 * Generic over the subject a notice is raised against, rather than one interface per caller:
 * `COVERAGE_NOTICES` below reads `Coverage`, and `review-body.ts`'s `POSTING_NOTICES` reads
 * `Posting`. Both are an order list, a union derived from it, and a table keyed by that union:
 * the same shape once rather than kept in step by hand between two files.
 */
export interface Notice<T> {
    /** How much of a reader's attention it asks for. A page renders it as GitHub's alert of that name. */
    level: "warning" | "note";
    /** Whether this run raises it. */
    raised: (subject: T) => boolean;
    /**
     * The sentence. `escape` goes around every stretch that came from a model, from GitHub or
     * from a file the review session could write, and around nothing else: a renderer for a
     * page passes the escaping it needs and a terminal passes the text through.
     */
    say: (subject: T, escape: Escape) => string;
}

/**
 * Every notice there is, in the order a reader meets them.
 *
 * The union comes from this list rather than the other way round, so a notice added here has
 * a place on the page before it has a sentence, and `COVERAGE_NOTICES` below fails to compile
 * until it gets one. The other half was already keyed and the rendering was not: a run could
 * raise a warning, `warned` could decide the review was worth posting on the strength of it,
 * and the body it posted said nothing about why.
 */
const COVERAGE_ORDER = ["unread", "changed", "unaccounted", "silent", "broken", "limited"] as const;

export type CoverageAlert = (typeof COVERAGE_ORDER)[number];

export const COVERAGE_NOTICES: Record<CoverageAlert, Notice<Coverage>> = {
    // First, because it is about the counts a reader has just read rather than about coverage
    // of the diff: a finding this review repeats is one whose answer went unread, and without
    // this the reader has only the repetition to go on.
    unread: {
        level: "warning",
        raised: (c) => c.unread.length > 0,
        say: (c, escape) => {
            const { kept, marker } = clampTo(c.unread.join(" "), MAX_UNREAD);

            return (
                "Part of the discussion on this pull request could not be read, so anything answered" +
                ` there is raised again: ${escape(kept)}${marker === "" ? "" : " (cut for length)"}`
            );
        },
    },

    // Above the coverage notices, because it is what decides how much they are worth: the lens
    // list they are counted from is one of the files it names.
    changed: {
        level: "warning",
        raised: (c) => c.sessionChanged.length > 0,
        say: (c, escape) =>
            `The review session changed ${escape(c.sessionChanged.join(", "))} under it.` +
            " The commit these findings are lines of, and the list of lenses counted below, are that" +
            " session's own answer rather than what this run built.",
    },

    // Its own notice, and not a lens missing from a list: with no `lens_health` at all there is
    // nothing to compare the dispatch list against, so `broken` and `limited` are empty too and
    // a run that accounted for none of its lenses would read as one with nothing to declare.
    // Everything a reader has for how much of this review to trust hangs off that array, and it
    // is optional to the model, so one omission takes the lens list, the coverage notices and
    // every standing sentence out at once. check-findings.ts writes a line to the job log, which
    // the person these caveats are for never opens.
    unaccounted: {
        level: "warning",
        raised: (c) => c.health.length === 0,
        say: () =>
            "This run reported nothing about which lenses ran or what they could not check," +
            " so how much of the change was covered is unknown.",
    },

    // Before `broken` and `limited`, because both are counted out of `lens_health` and so fall
    // short by exactly the lenses named here.
    silent: {
        level: "warning",
        raised: (c) => c.silent.length > 0,
        say: (c, escape) =>
            `${escape(c.silent.join(", "))} ran and reported nothing about themselves,` +
            " so nothing below accounts for them.",
    },

    broken: {
        level: "warning",
        raised: (c) => c.broken.length > 0,
        say: (c) =>
            `${c.broken.length} of ${lenses(c.health.length)} did not report normally,` +
            " so this review covers less than it appears to.",
    },

    // A note rather than a warning, and it belongs beside the rest anyway: what these decide is
    // whether a reader has to see the review at all, and a lens that could not render the page
    // is exactly the thing a green tick would be read as denying.
    limited: {
        level: "note",
        raised: (c) => c.limited.length > 0,
        say: (c) =>
            `${c.limited.length} of ${lenses(c.health.length)} named something they could not check.` +
            " The list below has each in its own words.",
    },
};

/**
 * The names in `order` whose notice `table` raises against `subject`, in `order`'s order.
 *
 * The one filter both notice tables use. `review-body.ts`'s `POSTING_NOTICES` is a `Notice<Posting>`
 * table with its own order tuple, and calls this the same way rather than repeating the filter.
 */
export function raisedIn<K extends string, T>(order: readonly K[], table: Record<K, Notice<T>>, subject: T): K[] {
    return order.filter((name) => table[name].raised(subject));
}

/** The notices this run raises, in the order above. */
export function noticesFor(coverage: Coverage): CoverageAlert[] {
    return raisedIn(COVERAGE_ORDER, COVERAGE_NOTICES, coverage);
}
