/**
 * What a run produced, and the rules for reading it.
 *
 * The shape the orchestrator returns, plus the two questions everything downstream asks of
 * it: how a finding ranks, and which findings this review is posting. Everything that
 * touches a finding depends on this, and nothing here depends on how a review is rendered.
 */

export interface Finding {
    found_by?: string[];
    file: string;
    line: number;
    end_line?: number;
    /**
     * One of `SEVERITY_ORDER`, but typed as a string because check-findings.ts keeps a
     * finding whose severity it could not repair rather than dropping it. `isListed` and
     * `severityRank` are where an unrecognised label is decided on.
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
 * longer has fails to compile instead of listing nothing at run time.
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

/**
 * The comments that can settle a finding, and what each one is about.
 *
 * A comment qualifies when someone entitled to settle a finding wrote it, or when it sits
 * on a thread somebody resolved. Resolving is the harder act: GitHub refuses
 * `resolveReviewThread` to a token that cannot write contents, so a resolved thread stands
 * on its own, and the association of the comments on it is no guide to who closed it.
 *
 * `onFile` is the file a comment's thread is anchored to. `inText` is the comment's own
 * words, which is all a conversation comment has to say what it is about.
 */
interface Settling {
    onFile: Map<string, string>;
    inText: Map<string, string>;
}

function settlingComments(existing: Existing): Settling {
    const onFile = new Map<string, string>();
    const inText = new Map<string, string>();

    const take = (c: Commenter | undefined, file: string, resolved: boolean): void => {
        if (!c?.url) return;
        if (!resolved && !MAY_DECLINE.has(c.association ?? "")) return;

        if (file) onFile.set(c.url, file);
        inText.set(c.url, c.body ?? "");
    };

    for (const thread of existing.threads ?? []) {
        const resolved = thread.resolved === true;
        const file = typeof thread.file === "string" ? thread.file : "";

        if (resolved && thread.url && file) onFile.set(thread.url, file);

        for (const comment of thread.comments ?? []) take(comment, file, resolved);
    }

    for (const comment of existing.conversation ?? []) take(comment, "", false);

    return { onFile, inText };
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
 * Whether a settling comment is about the file the finding is in.
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
function isAbout(settling: Settling, url: string, file: string): boolean {
    if (!file) return false;
    if (settling.onFile.get(url) === file) return true;

    const text = settling.inText.get(url);

    if (text === undefined) return false;

    const base = file.slice(file.lastIndexOf("/") + 1);

    return text.includes(file) || (base !== "" && text.includes(base));
}

export interface Vetted {
    findings: Finding[];
    /** Declines citing a comment nobody entitled wrote, or no comment that is there at all. */
    untraceable: number;
    /** Declines citing an entitled comment that says nothing about the finding's file. */
    unrelated: number;
}

/**
 * Reopen every decline that cannot be traced to someone entitled to make it, about the
 * finding it was made against.
 *
 * The orchestrator is told which associations may settle a finding, and it then takes that
 * rule and the comments it judges as text in one context, with nothing marking one as the
 * instruction. Anyone who can comment writes those comments, and a run that took one of
 * them for the rule would silence a finding for as long as the pull request lives. So the
 * decision is taken again here, against the association GitHub reported.
 *
 * When existing.json cannot be read, nothing can be traced and every decline is reopened.
 * That costs a comment somebody has already answered, and the other way costs a finding
 * nobody sees.
 */
export function vetDeclines(findings: Finding[], existing: unknown): Vetted {
    const parsed = typeof existing === "object" && existing !== null ? (existing as Existing) : {};
    const settling = settlingComments(parsed);
    let untraceable = 0;
    let unrelated = 0;

    const vetted = findings.map((f) => {
        if (f.status !== "declined") return f;

        const url = f.existing_comment_url;
        const entitled = url ? settling.onFile.has(url) || settling.inText.has(url) : false;

        if (url && entitled && isAbout(settling, url, f.file)) return f;

        if (entitled) unrelated += 1;
        else untraceable += 1;

        return { ...f, status: "new" as const };
    });

    return { findings: vetted, untraceable, unrelated };
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

export function lenses(n: number): string {
    return n === 1 ? "1 lens" : `${n} lenses`;
}
