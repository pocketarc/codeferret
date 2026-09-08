/**
 * What a run produced, and the rules for reading it.
 *
 * The shape the orchestrator returns, plus the questions everything downstream asks of it:
 * how a finding ranks, which findings this review is posting, and which of the suppressions
 * the comments on the pull request bear out. Everything that touches a finding depends on
 * this, and nothing here depends on how a review is rendered, reads a file, or ends a
 * process. The IO around it is in `read-run.ts`.
 */

import type { Located, Survey } from "./existing.ts";
import { record } from "./json.ts";
import { meetsThreshold, score, TIER_NAMES, tierOf as bandOf, tierRank, unratedAxes } from "./risk.ts";
import type { Risk, Tier } from "./risk.ts";

export type { Tier } from "./risk.ts";

export interface Finding {
    found_by?: string[];
    file: string;
    /** Optional because `finding-rules.ts` tolerates its absence. `lineOf` is the one reader. */
    line?: number;
    end_line?: number;
    /**
     * What the orchestrator answered on each risk axis. `tierOf` is the one reader.
     *
     * Optional and typed loosely for the reason `line` is: check-findings.ts keeps a finding
     * whose risk it could not repair, and `score` treats a value it does not recognise as
     * nothing rather than as the worst.
     */
    risk?: Partial<Risk>;
    /** Optional for the reason `line` is. */
    category?: string;
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

/**
 * What tier a finding sits in, computed from its risk answers every time it is asked.
 *
 * Derived rather than stored, so there is no second copy to disagree with `review/risk.ts`
 * and no field a session could write for itself. What the artifact carries is `risk`, the
 * answers, which is the more useful record anyway: a reader who disagrees with the weights
 * can re-score it, and nobody can re-derive answers from a tier.
 */
export function tierOf(f: Finding): Tier {
    return bandOf(score(f.risk ?? {}));
}

const WORST_RANK = Math.min(...TIER_NAMES.map(tierRank));

/**
 * Where a finding sorts. Lower is worse, so the worst reads first.
 *
 * A finding whose rating failed sorts with the worst, because `score` gives an absent or
 * unrecognised `risk` a 0 and 0 bands to `nit`. Ranked on that number, the findings `isListed`
 * rescues from the threshold sorted among the real nits, read last, and were dropped first by
 * the length cut: the one rating nobody can vouch for decided the order as if it were an answer.
 * The worst rank rather than a place among the rated ones, for the reason `isListed` prints
 * them at all: an unrated finding may be anything, and being wrong about it here costs a
 * reader a critical they never saw.
 */
export function findingRank(f: Finding): number {
    return isUnrated(f) ? WORST_RANK : tierRank(tierOf(f));
}

/**
 * A finding's line, where it has one a reader can be sent to.
 *
 * `POLICY` in finding-rules.ts tolerates a missing `line` and a `line` of `0`, so every
 * reader has to decide what to do without one, and each of them used to carry a guard
 * written from memory: two tested `Number.isInteger` alone and the third also tested the
 * value. Answered once here, and `undefined` rather than a sentinel, so a caller that forgets
 * it fails to compile rather than printing a `path:0` nobody can follow.
 */
export function lineOf(f: Finding): number | undefined {
    const line = f.line;

    return typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : undefined;
}

/**
 * Whether the body prints this finding whole.
 *
 * `vetSuppression` decides who may dismiss a finding for good on this same answer, so the set
 * it protects and the set a reader sees are one set. The tier alone was a different question:
 * a run that keeps no artifact prints every finding whatever its tier.
 *
 * `deferrable` is the caller's, like the threshold. Both are facts about the run rather than
 * about the finding, and a default is how a value comes to be read in one place and invented
 * in another.
 */
export function isPrinted(f: Finding, threshold: Tier, deferrable: boolean): boolean {
    return !deferrable || isListed(f, threshold);
}

/**
 * Whether this finding's tier clears the threshold.
 *
 * Private, and worth keeping that way. It is half of `isPrinted` and not a substitute for it:
 * on a run with no artifact the body prints findings this answers false for, and every caller
 * that reached for the tier alone got that wrong. Exported it would be the easier of the two
 * to reach for and the wrong one to reach for.
 */
function isListed(f: Finding, threshold: Tier): boolean {
    return isUnrated(f) || meetsThreshold(tierOf(f), threshold);
}

/**
 * Whether this finding's rating failed, rather than came out low.
 *
 * A tier is only a reason to leave a finding out where the tier means something. `unratedAxes`
 * has what goes wrong when it does not.
 */
export function isUnrated(f: Finding): boolean {
    return unratedAxes(f.risk).length > 0;
}

/** The findings whose rating failed, which the body says so about rather than hiding. */
export function unratedFindings(findings: Finding[]): Finding[] {
    return findings.filter(isUnrated);
}

/** The lenses that did not report normally, which is the count the body leads with. */
export function brokenLenses(health: LensHealth[]): LensHealth[] {
    return health.filter((h) => !h.ok);
}

/**
 * A lens's name without the plugin namespace `build-prompts.sh` gives it.
 *
 * A fact about how a lens is named rather than about how one is rendered, which is why it
 * sits here: finding-rules.ts matches dispatched lenses against reported ones and needs
 * nothing else from the rendering.
 */
export function lensLabel(lens: string): string {
    return lens.replace(/^[^:]+:/, "");
}

/**
 * The dispatched lenses with no account of themselves in `lens_health`.
 *
 * Both sides go through `lensLabel`. `dispatched` is namespaced, because that is how
 * build-prompts.sh writes the lens list, and what the orchestrator puts in `lens_health` is
 * a plain string as far as the schema is concerned. Compared as written, an orchestrator
 * that dropped the namespace would report every lens as silent at once, which is how an
 * alarm becomes one people skip.
 *
 * `reported` is the names as they arrived rather than the entries, so check-findings.ts can
 * ask this of a file whose shape has not been checked and the body can ask it of one whose
 * shape has.
 */
export function silentLenses(reported: string[], dispatched: string[]): string[] {
    const named = new Set(reported.map(lensLabel));

    return dispatched.map(lensLabel).filter((lens) => !named.has(lens));
}

export interface Partitioned {
    all: Finding[];
    /** The ones this review posts. */
    fresh: Finding[];
    suppressed: Finding[];
    declined: Finding[];
}

// GitHub's MEMBER association indicates organization membership, not repository permission.
export const MAY_DECLINE: ReadonlySet<string> = new Set(["OWNER", "COLLABORATOR"]);
export const MAY_DECLINE_PERMISSIONS: ReadonlySet<string> = new Set(["admin", "maintain", "push", "write"]);

/** Whether whoever wrote a comment has standing in the repository. */
function entitled(comment: Located): boolean {
    return (
        MAY_DECLINE.has(comment.association) ||
        (comment.association === "MEMBER" && MAY_DECLINE_PERMISSIONS.has(comment.repositoryPermission?.toLowerCase() ?? ""))
    );
}

/**
 * The shortest basename a comment may settle a finding by naming on its own.
 *
 * Below it the name is ordinary prose: `src/db`, `bin/x` and `cmd/id` all leave a basename
 * that turns up in a sentence about something else, and "we don't want that" would settle
 * every finding in `src/wa`. A shorter path has to be named in full.
 */
const MIN_BASENAME = 4;

/**
 * Whether `text` names `base` as a filename rather than as part of a longer word.
 *
 * The characters either side have to be outside a path, so "the id column" does not name
 * `id`. Scanned rather than turned into a regular expression, because the path comes from
 * model output and `.` and `*` in one would match far more than the name.
 */
function namesFile(text: string, base: string): boolean {
    const outside = (ch: string | undefined): boolean => ch === undefined || !/[A-Za-z0-9_.-]/.test(ch);

    for (let at = text.indexOf(base); at !== -1; at = text.indexOf(base, at + 1)) {
        if (outside(text[at - 1]) && outside(text[at + base.length])) return true;
    }

    return false;
}

/**
 * Whether a comment is about the file the finding is in.
 *
 * Without this the set is flat, and a maintainer who comments "LGTM, merging" settles every
 * finding on the pull request. A thread carries the file it is anchored to, so
 * a bare "intentional" reply on that thread settles a finding in that file. A conversation
 * comment carries nothing but its words, so it has to name the path or the file itself.
 *
 * The residual: a maintainer who settles one finding in a file settles every finding this
 * run made in that file, and a comment naming `a.ts` reaches a finding in any directory's
 * `a.ts`. Tighter than that starts reopening the declines a maintainer plainly meant, and
 * a repeated comment costs less than a finding nobody sees.
 */
function isAbout(comment: Located, file: string): boolean {
    if (!file) return false;
    if (comment.file !== "" && comment.file === file) return true;

    // The full path goes through `namesFile` too, and clears the same minimum length the
    // basename does. A bare `includes` skipped both: a root-level file has no directory, so
    // its whole path is its basename, and "the id column is fine" settled every finding in
    // `id`.
    if (file.length >= MIN_BASENAME && namesFile(comment.text, file)) return true;

    const base = file.slice(file.lastIndexOf("/") + 1);

    return base.length >= MIN_BASENAME && namesFile(comment.text, base);
}

export interface Vetted {
    findings: Finding[];
    /** Declines citing a comment nobody entitled wrote, or no comment that is there at all. */
    untraceable: number;
    /** Declines citing an entitled comment that says nothing about the finding's file. */
    unrelated: number;
    /**
     * `already-reported` findings the body prints in full, with nobody entitled having said so.
     *
     * Counted apart from `unreported` because it is the one reopening that happens with no
     * comment cited at all, and that is the ordinary shape of it. While the two shared a
     * counter, a maintainer watching a finding come back on every push was told it had cited a
     * comment, which sent them looking for one that was never there.
     */
    unvouched: number;
    /** `already-reported` findings citing a comment that is absent or about another file. */
    unreported: number;
    /** `already-reported` findings citing no comment, in a file the last review raised nothing in. */
    unmatched: number;
}

/** Every reason a suppression is reopened, which is every counter `Vetted` carries. */
export type Reopening = Exclude<keyof Vetted, "findings">;

/**
 * All of them at zero, which is also the list of them.
 *
 * The counters were five `let`s incremented at five sites and reassembled into a literal at
 * the end, so a sixth reason meant four edits and getting three of them right left a counter
 * that was always zero with nothing saying so. `reopenedReasons` has been keyed off this
 * union since it was written; this is the producing side catching up, and a counter added to
 * `Vetted` now fails to compile here until it is seeded.
 */
function noReopenings(): Record<Reopening, number> {
    return { untraceable: 0, unrelated: 0, unvouched: 0, unreported: 0, unmatched: 0 };
}

/**
 * Whether the previous review raised anything in this file.
 *
 * The bar an `already-reported` finding that cites no comment is held to, and deliberately
 * the same one `isAbout` applies to a comment: the file, not the finding. Titles are the
 * wrong key even though the orchestrator matches on them. It is told to match the defect
 * rather than the prose, and it rewrites a title every run as the lenses word it
 * differently, so an exact comparison here would reopen suppressions that are correct: on
 * the run this was measured against, all seven of them.
 *
 * The residual is the one `isAbout` already carries: a file the last review raised anything
 * in will bear out any suppression this run makes in it. What it still catches is a
 * suppression with nothing at all behind it, which is what this path had before.
 */
function raisedBefore(raisedFiles: ReadonlySet<string>, file: string): boolean {
    return file !== "" && raisedFiles.has(file);
}

/**
 * Why a decline does not stand, or null where it does.
 *
 * A decline needs an author with standing, or, for a finding the body prints as one line, a
 * thread somebody closed. GitHub closes a conversation for anyone with repository write or for
 * whoever opened the pull request, and `resolveReviewThread` grants neither, so on a branch from
 * an outside contributor the only person who can close a thread is the one whose work is under
 * review: open a thread on a line, have any account reply "intentional", close it, and every
 * finding in that file is declined for as long as the pull request lives. Replying to a closed
 * thread takes no more than commenting and does not reopen it, so a reply there settles the file
 * its thread is anchored to and nothing else.
 *
 * A finding the body prints in full is held to the association instead, matching `vetReported`
 * below. `printed` is what the body itself filters on, so the set this protects and the set a
 * reader sees are the same set.
 *
 * `orchestrator.md` carves out a security defect from any reply, and that carve-out is prompt
 * text sitting in the same context as the comments it judges, so this is where refusing costs
 * an attacker anything.
 */
function vetDecline(f: Finding, cited: Located | undefined, printed: boolean): Reopening | null {
    const closed = cited?.onClosedThread === true && !printed;

    if (!cited || !(entitled(cited) || closed)) return "untraceable";

    const about = entitled(cited) ? isAbout(cited, f.file) : cited.file !== "" && cited.file === f.file;

    return about ? null : "unrelated";
}

/**
 * Why an `already-reported` finding does not stand, or null where it does.
 *
 * A defect somebody has written down is a defect somebody has written down, whoever they are,
 * and it keeps its line in the review either way, so all this ordinarily needs is that what it
 * rests on is there and is about the same file: a comment where it cites one, and otherwise the
 * previous review, which is where the orchestrator is told to take the status from.
 *
 * An authorized reviewer may decline a finding in an uncited comment. Check those comments too
 * before suppressing a finding included in full in the review body. The lower bar rests on the
 * finding keeping its line either way, and for these that is not the whole of it: the body prints
 * them whole and everything else as one line in a collapsed block, so demoting one is the
 * difference between a reader seeing the defect and seeing its title.
 *
 * `printed` rather than a test spelled out here: when each side named its own set, a finding
 * graded `blocker` took the whole page and the low bar at once. `vetDecline` above takes a
 * comment on a thread somebody closed, and the two agree about what that is worth: closure is
 * standing enough for a finding printed as one line, and not for one taking a reader off the
 * page. Widening either to take a closed thread at any tier is the edit to refuse.
 *
 * Citing nothing leaves less to check, and the bar is the same either way. While the bar applied
 * only where a url was present, omitting the url skipped it and fell through to `raisedBefore`,
 * which asks only whether the previous review raised anything at all in that file, at any tier.
 * A nit in the same file would then settle a critical.
 *
 * What that costs is the whole printed section, on every push. Most `already-reported` findings
 * cite no comment, because STEP 3 of `orchestrator.md` asks for the status from `previous.json`
 * and for a url only where the entry has one, so on the shipped defaults every finding at or
 * above the threshold comes back as new and is printed again until somebody entitled answers it
 * in writing. Narrowing the test to one tier would buy the repetition back and break the coupling
 * above in the direction that matters: a `high` finding a reader is looking at would then be
 * settled by the previous review alone.
 */
function vetReported(
    f: Finding,
    cited: Located | undefined,
    raisedFiles: ReadonlySet<string>,
    printed: boolean,
): Reopening | null {
    if (printed && !(cited && entitled(cited))) return "unvouched";

    if (f.existing_comment_url) return cited && isAbout(cited, f.file) ? null : "unreported";

    return raisedBefore(raisedFiles, f.file) ? null : "unmatched";
}

/**
 * Reopen every suppression that the comments on the pull request do not bear out.
 *
 * The orchestrator is told which associations may settle a finding, and it then takes that
 * rule and the comments it judges as text in one context, with nothing marking one as the
 * instruction. Anyone who can comment writes those comments, and a run that took one of
 * them for the rule would silence a finding for as long as the pull request lives. So the
 * decision is taken again here, against what GitHub reported.
 *
 * The two statuses are held to different bars, and each bar is a function of its own above.
 * What stays here is the dispatch and the counting: one increment site, whatever a policy
 * answers.
 *
 * When existing.json or previous.json cannot be read, nothing can be traced and every
 * suppression resting on it is reopened. That costs a comment somebody has already answered,
 * and the other way costs a finding nobody sees.
 *
 * Both inputs arrive already narrowed, at the boundary where the file each comes from is read.
 * Taking `unknown` and calling `survey(asExisting(…))` here re-narrowed a value that already
 * carried the guarantee, and walked it a second time after post-review.ts had walked it for
 * its linkable urls, which is exactly the double walk `survey` exists to prevent. `raisedFiles`
 * was the same mistake one step behind: an `unknown` defaulted to `{}`, so a caller that passed
 * nothing got an empty set and every uncited `already-reported` finding reopened, and the
 * signature said that was a legitimate way to call this.
 */
export function vetSuppression(
    findings: Finding[],
    discussion: Survey,
    raisedFiles: ReadonlySet<string>,
    threshold: Tier,
    /** Whether the run has an artifact to send a reader to. */
    deferrable: boolean,
): Vetted {
    const { comments } = discussion;
    const counts = noReopenings();

    // One increment site, named by the same union the sentences are keyed off, so a reason
    // cannot be raised without being counted or counted without being explained.
    const reopen = (f: Finding, why: Reopening): Finding => {
        counts[why] += 1;

        return { ...f, status: "new" as const };
    };

    const vetted = findings.map((f) => {
        const url = f.existing_comment_url;
        const cited = url ? comments.get(url) : undefined;
        // Computed once and handed to whichever policy applies, so the two policies and the body
        // cannot differ about which findings are printed in full.
        const printed = isPrinted(f, threshold, deferrable);

        const why =
            f.status === "declined"
                ? vetDecline(f, cited, printed)
                : f.status === "already-reported"
                  ? vetReported(f, cited, raisedFiles, printed)
                  : null;

        return why === null ? f : reopen(f, why);
    });

    return { findings: vetted, ...counts };
}

/** Whether a parsed file is something this module can read as a run's output. */
function isFinding(value: unknown): value is Finding {
    const finding = record(value);
    const statuses = new Set(["new", "already-reported", "declined"]);

    if (!finding || typeof finding.file !== "string" || typeof finding.title !== "string" || typeof finding.body !== "string") {
        return false;
    }

    if (finding.found_by !== undefined && (!Array.isArray(finding.found_by) || finding.found_by.some((name) => typeof name !== "string"))) {
        return false;
    }

    if (finding.risk !== undefined && record(finding.risk) === null) return false;
    if (finding.status !== undefined && (typeof finding.status !== "string" || !statuses.has(finding.status))) return false;

    return true;
}

export function isMerged(value: unknown): value is Merged {
    const merged = record(value);

    return merged !== null && Array.isArray(merged.findings) && merged.findings.every(isFinding);
}

/**
 * Whether this review posts the finding rather than reporting it as already answered.
 *
 * The rule `partition` splits on, exported so that `coverageOf` counts against the same set.
 */
export function isFresh(f: Finding): boolean {
    return f.status !== "already-reported" && f.status !== "declined";
}

/** Every finding, worst first, and the three subsets the review is rendered from. */
export function partition(findings: Finding[]): Partitioned {
    const all = [...findings].sort((a, b) => findingRank(a) - findingRank(b));

    return {
        all,
        fresh: all.filter(isFresh),
        suppressed: all.filter((f) => f.status === "already-reported"),
        declined: all.filter((f) => f.status === "declined"),
    };
}
