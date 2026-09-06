/**
 * What is already on the pull request: the shape of `existing.json`, and the one walk over
 * it.
 *
 * The file crossed three modules with a partial description in each and a cast at every
 * seam, so `thread_id` and `mine` were absent from the type the vetting used and
 * `post-review.ts` re-narrowed the same bytes to get them back. One declaration here, and a
 * field `fetch-existing.ts` renames stops compiling rather than reading as absent.
 *
 * Every field is optional and nothing is trusted. `run.sh` empties this file once the session
 * has exited, and the paths that post and print fetch it again, so what is read here is
 * ordinarily a copy taken minutes ago; a half-written one still has to come back as a file
 * that says nothing rather than as a crash.
 */

import { join } from "node:path";
import { record } from "./json.ts";

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

/**
 * The same file with both lists guaranteed, which is what every reader here is handed.
 *
 * Apart from `Existing` because that is the shape on disk, where either list may be missing.
 * Read back as `Existing`, the file hides the guarantee `asExisting` makes, so every caller
 * defends against it again with a `?? []` that never applies, and the one that forgets reads
 * `undefined` in silence.
 */
export interface Surveyed extends Existing {
    threads: Threaded[];
    conversation: Commenter[];
}

/** The parsed file, or one that says nothing, without trusting what is on disk. */
export function asExisting(value: unknown): Surveyed {
    const parsed = record(value);

    return {
        threads: Array.isArray(parsed?.threads) ? parsed.threads : [],
        conversation: Array.isArray(parsed?.conversation) ? parsed.conversation : [],
        ...(typeof parsed?.error === "string" ? { error: parsed.error } : {}),
        ...(typeof parsed?.conversation_error === "string" ? { conversation_error: parsed.conversation_error } : {}),
    };
}

/** The file beside a run's findings, or one that says nothing. */
export async function readExisting(buildDir: string, absent: (line: string) => void): Promise<Surveyed> {
    const file = Bun.file(join(buildDir, "existing.json"));

    if (!(await file.exists())) return asExisting({});

    try {
        return asExisting(JSON.parse(await file.text()));
    } catch {
        absent("existing.json could not be read, so no thread is resolved and every suppression is reopened.");
        return asExisting({});
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
     * The same urls as the keys of `comments`, because `fetch-existing.ts` writes a thread's
     * url as its first comment's and that comment is keyed here too. Named apart from them
     * because the two answer different questions: `mention` asks only whether the pull request
     * carries a url, and the vetting asks what the comment behind one says about which file.
     *
     * This was documented as the wider set and never has been one, which left a reader
     * auditing `mention`'s bound looking for a difference no input a run makes could produce.
     * Widening it means giving a thread a url of its own in the fetch, and a reason to.
     */
}

/**
 * One walk, so the two views cannot disagree about what the pull request carries.
 *
 * Built twice in two modules before this, with the difference above unstated in either.
 */
export function survey(existing: Surveyed): Survey {
    const comments = new Map<string, Located>();

    const take = (c: Commenter | undefined, file: string, onClosedThread: boolean): void => {
        if (!c?.url) return;

        comments.set(c.url, {
            file,
            text: c.body ?? "",
            association: c.association ?? "",
            onClosedThread,
        });
    };

    for (const thread of existing.threads) {
        const closed = thread?.resolved === true;
        const file = typeof thread?.file === "string" ? thread.file : "";

        for (const comment of thread?.comments ?? []) take(comment, file, closed);
    }

    for (const comment of existing.conversation) take(comment, "", false);

    return { comments };
}

/**
 * What the fetch could not read, in the words `fetch-existing.ts` wrote.
 *
 * Half the fetch can fail on its own, and the file is still valid JSON: it carries the half
 * that came back and names the half that did not. Nothing read those two fields, so the run
 * vetted every suppression resting on the missing half and reopened it, which is the safe
 * direction, and the reader of the pull request got a review repeating findings they had
 * answered with nothing on the page saying the discussion was half read.
 */
export function unreadOf(existing: Surveyed): string[] {
    return [existing.error, existing.conversation_error].filter((line): line is string => Boolean(line));
}

/** The threads an earlier run of this tool opened, which are the only ones it may resolve. */
export function ownThreads(existing: Surveyed): Set<string> {
    const mine = new Set<string>();

    for (const thread of existing.threads) {
        if (thread?.mine === true && typeof thread.thread_id === "string") mine.add(thread.thread_id);
    }

    return mine;
}

/** One thread the orchestrator judged finished, as `merged.resolve` carries it. */
export interface Asked {
    thread_id: string;
    reason: string;
}

/** Which of the threads the orchestrator named this run may close, and which it may not. */
export interface Plan {
    close: Asked[];
    /** Named but not this run's to close, which is a line on stderr rather than a mutation. */
    foreign: Asked[];
}

/**
 * The threads to close, out of the ones the orchestrator asked for.
 *
 * `mine` is the non-model signal beside the orchestrator's judgement: fetch-existing.ts
 * computes it, and has what a thread must carry to be marked. Closing somebody else's thread
 * takes their words off the page, and the next run reads a closed thread back as a declined
 * finding, so one wrong call suppresses a finding for good.
 *
 * `mayResolve` empties both lists rather than only the first. build-prompts.sh renders a
 * different orchestrator prompt when `resolve-threads` is off, and a model can be talked out
 * of a prompt, so a run with it off reports nothing about whose threads they were either.
 *
 * Here rather than in post-review.ts, for the reason finding-rules.ts gives for the split it
 * describes: a rule in a script body is a rule whose test has to spawn a process and read its
 * log.
 */
export function planResolution(asked: Asked[], mine: ReadonlySet<string>, mayResolve: boolean): Plan {
    if (!mayResolve) return { close: [], foreign: [] };

    return {
        close: asked.filter((entry) => mine.has(entry.thread_id)),
        foreign: asked.filter((entry) => !mine.has(entry.thread_id)),
    };
}
