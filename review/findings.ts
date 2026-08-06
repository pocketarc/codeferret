/**
 * What a run produced, and the rules for reading it.
 *
 * The shape the orchestrator returns, plus the questions everything downstream asks of it:
 * how a finding ranks, which findings this review is posting, and which of the suppressions
 * the comments on the pull request bear out. Everything that touches a finding depends on
 * this, and nothing here depends on how a review is rendered.
 */

import { join } from "node:path";

export interface Finding {
    found_by?: string[];
    file: string;
    line: number;
    end_line?: number;
    /**
     * One of `SEVERITY_ORDER`, but typed as a string because check-findings.ts keeps a
     * finding whose severity it could not repair. `isListed` and `severityRank` are where
     * an unrecognised label is decided on.
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
 * longer has fails to compile. As strings it would silently list nothing at run time.
 */
const LISTED_SEVERITIES: readonly Severity[] = ["critical", "high"];

export const LISTED: ReadonlySet<string> = new Set(LISTED_SEVERITIES);

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

/** GitHub's `authorAssociation` values for someone with standing in the repository. */
const MAY_DECLINE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface Commenter {
    association?: string;
    url?: string;
    body?: string;
}

interface Threaded {
    resolved?: boolean;
    url?: string;
    file?: string;
    comments?: Commenter[];
}

interface Existing {
    threads?: Threaded[];
    conversation?: Commenter[];
}

/** One comment on the pull request, as the two questions asked of it. */
interface Comment {
    /** The file this comment's thread is anchored to. Empty for a conversation comment. */
    file: string;
    /** The comment's own words, which is all a conversation comment has to say what it is about. */
    text: string;
    /** Whether whoever wrote it has standing in the repository. */
    entitled: boolean;
    /** Whether it sits on a thread somebody closed. */
    onClosedThread: boolean;
}

/**
 * Every comment the pull request carries, by url, whoever wrote it.
 *
 * A url reaching this map says nothing about what it may settle. `vetSuppression` asks that
 * of each entry: a decline needs an entitled author or a closed thread, and an
 * `already-reported` finding needs only a comment that is there and is about the same file.
 */
function commentsOn(existing: Existing): Map<string, Comment> {
    const all = new Map<string, Comment>();

    const take = (c: Commenter | undefined, file: string, onClosedThread: boolean): void => {
        if (!c?.url) return;

        all.set(c.url, {
            file,
            text: c.body ?? "",
            entitled: MAY_DECLINE.has(c.association ?? ""),
            onClosedThread,
        });
    };

    for (const thread of existing.threads ?? []) {
        const closed = thread.resolved === true;
        const file = typeof thread.file === "string" ? thread.file : "";

        // A thread whose own url names no comment still stands for the file it is anchored
        // to, and the loop below overwrites this the moment the root comment carries it.
        if (closed && thread.url && file) {
            all.set(thread.url, { file, text: "", entitled: false, onClosedThread: true });
        }

        for (const comment of thread.comments ?? []) take(comment, file, closed);
    }

    for (const comment of existing.conversation ?? []) take(comment, "", false);

    return all;
}

/**
 * Every comment url the pull request carries, whoever wrote it.
 *
 * `review-body.ts` renders `existing_comment_url` as a link, and that url is the
 * orchestrator's word for where a finding was answered. An `already-reported` finding is
 * vetted nowhere else, so without this a comment written by anyone who can comment can put
 * an arbitrary link into a review posted under the bot's name.
 */
export function commentUrls(existing: unknown): ReadonlySet<string> {
    const parsed = typeof existing === "object" && existing !== null ? (existing as Existing) : {};
    const urls = new Set<string>();

    for (const thread of parsed.threads ?? []) {
        if (thread.url) urls.add(thread.url);

        for (const comment of thread.comments ?? []) {
            if (comment?.url) urls.add(comment.url);
        }
    }

    for (const comment of parsed.conversation ?? []) {
        if (comment?.url) urls.add(comment.url);
    }

    return urls;
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
function isAbout(comment: Comment, file: string): boolean {
    if (!file) return false;
    if (comment.file !== "" && comment.file === file) return true;
    if (comment.text.includes(file)) return true;

    const base = file.slice(file.lastIndexOf("/") + 1);

    return base.length >= MIN_BASENAME && namesFile(comment.text, base);
}

export interface Vetted {
    findings: Finding[];
    /** Declines citing a comment nobody entitled wrote, or no comment that is there at all. */
    untraceable: number;
    /** Declines citing an entitled comment that says nothing about the finding's file. */
    unrelated: number;
    /** `already-reported` findings citing a comment that is absent or about another file. */
    unreported: number;
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
 * The two statuses are held to different bars. A decline needs an author with standing, or
 * a thread somebody closed: closing one takes repository write, which `resolveReviewThread`
 * does not grant. Replying to a closed thread takes no more than commenting and does
 * not reopen it, so a reply there settles the file its thread is anchored to and nothing
 * else. An `already-reported` finding is a defect somebody has written down, whoever they
 * are, and it stays a finding in the file either way, so all it needs is that the comment
 * it cites exists and is about the same file.
 *
 * When existing.json cannot be read, nothing can be traced and every suppression is
 * reopened. That costs a comment somebody has already answered, and the other way costs a
 * finding nobody sees.
 */
export function vetSuppression(findings: Finding[], existing: unknown): Vetted {
    const parsed = typeof existing === "object" && existing !== null ? (existing as Existing) : {};
    const comments = commentsOn(parsed);
    let untraceable = 0;
    let unrelated = 0;
    let unreported = 0;

    const reopen = (f: Finding): Finding => ({ ...f, status: "new" as const });

    const vetted = findings.map((f) => {
        const url = f.existing_comment_url;
        const cited = url ? comments.get(url) : undefined;

        if (f.status === "declined") {
            if (!cited || !(cited.entitled || cited.onClosedThread)) {
                untraceable += 1;
                return reopen(f);
            }

            const about = cited.entitled ? isAbout(cited, f.file) : cited.file !== "" && cited.file === f.file;

            if (about) return f;

            unrelated += 1;
            return reopen(f);
        }

        // No url is the ordinary case: `previous.json` carries what the last run reported,
        // and a finding matched against it names no comment.
        if (f.status === "already-reported" && url) {
            if (cited && isAbout(cited, f.file)) return f;

            unreported += 1;
            return reopen(f);
        }

        return f;
    });

    return { findings: vetted, untraceable, unrelated, unreported };
}

/** Whether a parsed file is something this module can read as a run's output. */
export function isMerged(value: unknown): value is Merged {
    return typeof value === "object" && value !== null && Array.isArray((value as Merged).findings);
}

export interface Vetting extends Vetted {
    /** What the vetting was decided against, which post-review.ts also reads its threads from. */
    existing: unknown;
}

/**
 * Vet a run's suppressions against the discussion on the pull request.
 *
 * One reader for the two entry points, so a session and a posted review cannot vet the same
 * findings against different files, and so the sentence saying what an unreadable file costs
 * is written once.
 *
 * `run.sh` fetches this file again once the orchestrator has exited, and the comment there
 * has why: the orchestrator was handed the path, so it could have written the copy its own
 * suppressions are checked against.
 */
export async function vetAgainstExisting(findings: Finding[], buildDir: string): Promise<Vetting> {
    const file = Bun.file(join(buildDir, "existing.json"));
    let existing: unknown = {};

    if (await file.exists()) {
        try {
            existing = JSON.parse(await file.text());
        } catch {
            console.error(
                "existing.json could not be read, so no thread is resolved and every suppression is reopened.",
            );
        }
    }

    return { existing, ...vetSuppression(findings, existing) };
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
