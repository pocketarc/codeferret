/**
 * What is already on the pull request: the shape of `existing.json`, and the one walk over
 * it.
 *
 * The file crossed three modules with a partial description in each and a cast at every
 * seam, so `thread_id` and `mine` were absent from the type the vetting used and
 * `post-review.ts` re-narrowed the same bytes to get them back. One declaration here, and a
 * field `fetch-existing.ts` renames stops compiling rather than reading as absent.
 *
 * Every field is optional and nothing is trusted. `run.sh` refetches this file after the
 * session, but a by-hand run reads whatever is on disk, and a half-written one has to come
 * back as a file that says nothing rather than as a crash.
 */

import { join } from "node:path";

/** One comment, whoever wrote it. */
export interface Commenter {
    author?: string;
    /** GitHub's `authorAssociation`, which is what says whether they may settle anything. */
    association?: string;
    url?: string;
    body?: string;
}

/** One review thread, anchored to a line of a file. */
export interface Threaded {
    thread_id?: string;
    resolved?: boolean;
    /** GitHub collapses an outdated thread, so the author of the pull request never sees it. */
    outdated?: boolean;
    file?: string;
    line?: number | null;
    url?: string;
    /** Whether an earlier run of this tool opened the thread. `fetch-existing.ts` has the test. */
    mine?: boolean;
    comments?: Commenter[];
}

export interface Existing {
    threads?: Threaded[];
    conversation?: Commenter[];
    /** The threads could not be read, which is not the same as nobody having said anything. */
    error?: string;
    /** The same for the comments outside a thread. */
    conversation_error?: string;
}

/** The parsed file, or one that says nothing, without trusting what is on disk. */
export function asExisting(value: unknown): Existing {
    if (typeof value !== "object" || value === null) return {};

    const parsed = value as Existing;

    return {
        threads: Array.isArray(parsed.threads) ? parsed.threads : [],
        conversation: Array.isArray(parsed.conversation) ? parsed.conversation : [],
        ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
        ...(typeof parsed.conversation_error === "string" ? { conversation_error: parsed.conversation_error } : {}),
    };
}

/** The file beside a run's findings, or one that says nothing. */
export async function readExisting(buildDir: string, absent: (line: string) => void): Promise<Existing> {
    const file = Bun.file(join(buildDir, "existing.json"));

    if (!(await file.exists())) return {};

    try {
        return asExisting(JSON.parse(await file.text()));
    } catch {
        absent("existing.json could not be read, so no thread is resolved and every suppression is reopened.");
        return {};
    }
}

/** One comment, reduced to what deciding a suppression needs of it. */
export interface Located {
    /** The file this comment's thread is anchored to. Empty for a conversation comment. */
    file: string;
    /** The comment's own words, which is all a conversation comment has to say what it is about. */
    text: string;
    /** GitHub's `authorAssociation` for whoever wrote it. */
    association: string;
    /** Whether it sits on a thread somebody closed. */
    onClosedThread: boolean;
}

export interface Survey {
    /** Every comment the pull request carries, by url. */
    comments: Map<string, Located>;
    /**
     * Every url the pull request carries, which is what a review body may render as a link.
     *
     * A wider set than the keys of `comments`, on purpose. A thread's own url is linkable
     * whatever state the thread is in, because the pull request really does carry it; it
     * only stands as a *comment* about a file when the thread is closed and anchored, which
     * is what makes it evidence rather than a location.
     */
    linkable: Set<string>;
}

/**
 * One walk, so the two views cannot disagree about what the pull request carries.
 *
 * Built twice in two modules before this, with the difference above unstated in either.
 */
export function survey(existing: Existing): Survey {
    const comments = new Map<string, Located>();
    const linkable = new Set<string>();

    const take = (c: Commenter | undefined, file: string, onClosedThread: boolean): void => {
        if (!c?.url) return;

        linkable.add(c.url);
        comments.set(c.url, {
            file,
            text: c.body ?? "",
            association: c.association ?? "",
            onClosedThread,
        });
    };

    for (const thread of existing.threads ?? []) {
        const closed = thread?.resolved === true;
        const file = typeof thread?.file === "string" ? thread.file : "";

        if (thread?.url) linkable.add(thread.url);

        // A thread whose own url names no comment still stands for the file it is anchored
        // to, and the loop below overwrites this the moment the root comment carries it.
        if (closed && thread?.url && file) {
            comments.set(thread.url, { file, text: "", association: "", onClosedThread: true });
        }

        for (const comment of thread?.comments ?? []) take(comment, file, closed);
    }

    for (const comment of existing.conversation ?? []) take(comment, "", false);

    return { comments, linkable };
}

/** The threads an earlier run of this tool opened, which are the only ones it may resolve. */
export function ownThreads(existing: Existing): Set<string> {
    const mine = new Set<string>();

    for (const thread of existing.threads ?? []) {
        if (thread?.mine === true && typeof thread.thread_id === "string") mine.add(thread.thread_id);
    }

    return mine;
}
