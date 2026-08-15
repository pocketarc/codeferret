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

export interface Finding {
    found_by?: string[];
    file: string;
    /** Optional because `finding-rules.ts` tolerates its absence. `lineOf` is the one reader. */
    line?: number;
    end_line?: number;
    /**
     * One of `SEVERITY_ORDER`, but typed as a string because check-findings.ts keeps a
     * finding whose severity it could not repair. `isListed` and `severityRank` are where
     * an unrecognised label is decided on.
     */
    severity: string;
    /** Optional for the reason `line` is. `severity` above is widened instead of made optional. */
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

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "nit", "question"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

/**
 * The severities the body carries in full when it has a run to defer the rest to.
 *
 * Everything else is in the findings file, which is what the agent doing the fixing reads.
 * A person reading the pull request gets the two that decide whether to stop and look.
 *
 * Declared as severities rather than as strings, so a name in this set that the schema no
 * longer has fails to compile. As strings it would silently list nothing at run time.
 */
const LISTED_SEVERITIES: readonly Severity[] = ["critical", "high"];

export const LISTED: ReadonlySet<string> = new Set(LISTED_SEVERITIES);

export function severityRank(s: string): number {
    const i = SEVERITY_ORDER.findIndex((known) => known === s);
    return i === -1 ? SEVERITY_ORDER.length : i;
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

/** GitHub's `authorAssociation` values for someone with standing in the repository. */
const MAY_DECLINE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Whether whoever wrote a comment has standing in the repository. */
function entitled(comment: Located): boolean {
    return MAY_DECLINE.has(comment.association);
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
     * counter, a maintainer watching a critical come back on every push was told the finding
     * had cited a comment, which sent them looking for one that was never there.
     */
    unvouched: number;
    /** `already-reported` findings citing a comment that is absent or about another file. */
    unreported: number;
    /** `already-reported` findings citing no comment, in a file the last review raised nothing in. */
    unmatched: number;
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
 * Reopen every suppression that the comments on the pull request do not bear out.
 *
 * The orchestrator is told which associations may settle a finding, and it then takes that
 * rule and the comments it judges as text in one context, with nothing marking one as the
 * instruction. Anyone who can comment writes those comments, and a run that took one of
 * them for the rule would silence a finding for as long as the pull request lives. So the
 * decision is taken again here, against what GitHub reported.
 *
 * The two statuses are held to different bars. A decline needs an author with standing, or, for
 * a finding the body prints as one line, a thread somebody closed: closing one takes repository
 * write or authorship of the pull request, and `resolveReviewThread` grants neither. Replying to
 * a closed thread takes no more than commenting and does not reopen it, so a reply there
 * settles the file its thread is anchored to and nothing else. An `already-reported` finding
 * is a defect somebody has written down, whoever they are, and it stays a finding in the file
 * either way, so all it needs is that what it rests on is there and is about the same file: a
 * comment where it cites one, and otherwise the previous review, which is where the
 * orchestrator is told to take the status from.
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
export function vetSuppression(findings: Finding[], discussion: Survey, raisedFiles: ReadonlySet<string>): Vetted {
    const { comments } = discussion;
    let untraceable = 0;
    let unrelated = 0;
    let unvouched = 0;
    let unreported = 0;
    let unmatched = 0;

    const reopen = (f: Finding): Finding => ({ ...f, status: "new" as const });

    const vetted = findings.map((f) => {
        const url = f.existing_comment_url;
        const cited = url ? comments.get(url) : undefined;

        if (f.status === "declined") {
            // A closed thread stands for every finding the body prints as one line. GitHub
            // resolves a conversation for anyone with repository write, or for whoever opened
            // the pull request, so on a branch from an outside contributor the only person
            // who can close a thread is the one whose work is under review: open a thread on
            // a line, have any account reply "intentional", close it, and every finding in
            // that file is declined for as long as the pull request lives.
            //
            // The severities that carry the review are held to the association instead,
            // matching the `already-reported` branch below. `orchestrator.md` carves out a
            // security defect from any reply, and that carve-out is prompt text sitting in
            // the same context as the comments it judges, so this branch is where refusing
            // costs an attacker anything.
            const closed = cited?.onClosedThread === true && !isListed(f);

            if (!cited || !(entitled(cited) || closed)) {
                untraceable += 1;
                return reopen(f);
            }

            const about = entitled(cited) ? isAbout(cited, f.file) : cited.file !== "" && cited.file === f.file;

            if (about) return f;

            unrelated += 1;
            return reopen(f);
        }

        if (f.status === "already-reported") {
            // A finding the body prints in full takes an owner, a member or a collaborator
            // saying so, whether or not a comment is cited. The lower bar below rests on the
            // finding keeping its line in the review either way, and for these that is not the
            // whole of it: the body prints them whole and everything else as one line in a
            // collapsed block, so demoting one is the difference between a reader seeing the
            // defect and seeing its title.
            //
            // `isListed` and not `LISTED`, because those are two different sets and the
            // argument above is about the first. A severity nothing recognises is printed in
            // full as well, for the reason `isListed` carries: a label nobody chose is no
            // ground for dropping a defect out of a comment. Testing `LISTED` here held such a
            // finding to the low bar while the body gave it the whole page, and a review that
            // repairs `Critical` but not `blocker` treats the two differently for no reason a
            // reader could find.
            //
            // The decline branch above takes a comment on a thread somebody closed, and the
            // two branches agree about a critical: closure is standing enough for a finding
            // printed as one line, and not for one taking a reader off the page.
            // Whoever replied under the thread needed no more than the ability to comment,
            // and whoever closed it needed repository write or authorship of the pull
            // request. Widening either branch to take a closed thread at any severity is the
            // edit to refuse.
            //
            // Citing nothing is not the weaker case, it is the emptier one. Gated on a url
            // being present, omitting the url skipped the bar and fell through to
            // `raisedBefore`, which asks only whether the previous review raised anything at
            // all in that file, at any severity. A low finding in the same file would then
            // settle a critical. So the bar is the same whether or not a comment is cited.
            //
            // The cost is a critical that was genuinely reported before and never commented
            // on, printed in full again on every push. Criticals are rare and that is the
            // direction to be wrong in.
            if (isListed(f) && !(cited && entitled(cited))) {
                unvouched += 1;
                return reopen(f);
            }

            if (url) {
                if (cited && isAbout(cited, f.file)) return f;

                unreported += 1;
                return reopen(f);
            }

            // No url is the ordinary path rather than an edge case: STEP 3 tells the
            // orchestrator to take this status from `previous.json` and to copy a url only
            // where the entry has one, so most suppressions arrive with nothing cited. Left
            // to fall through, they were the one status decided by the orchestrator alone
            // and re-decided nowhere, and the status carries into every later run.
            if (raisedBefore(raisedFiles, f.file)) return f;

            unmatched += 1;
            return reopen(f);
        }

        return f;
    });

    return { findings: vetted, untraceable, unrelated, unvouched, unreported, unmatched };
}

/** Whether a parsed file is something this module can read as a run's output. */
export function isMerged(value: unknown): value is Merged {
    return typeof value === "object" && value !== null && Array.isArray((value as Merged).findings);
}

/**
 * Every finding in severity order, and the three subsets the review is rendered from.
 *
 * `suppressed` and `declined` come back rather than being filtered away, because the review
 * body prints both counts: a matcher that starts dropping findings shows up as a number.
 */
export function partition(findings: Finding[]): Partitioned {
    const all = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

    return {
        all,
        fresh: all.filter((f) => f.status !== "already-reported" && f.status !== "declined"),
        suppressed: all.filter((f) => f.status === "already-reported"),
        declined: all.filter((f) => f.status === "declined"),
    };
}
