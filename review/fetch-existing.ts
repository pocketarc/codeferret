#!/usr/bin/env bun
/**
 * Collect the discussion already on a pull request: every review thread with its
 * comments, and the conversation comments that are not anchored to a line.
 *
 * Every author counts. A finding a human already raised does not need raising again, and
 * a reply is where the answer to a finding lives.
 *
 * Threads come from GraphQL because REST exposes neither the thread id needed to resolve
 * a thread nor whether it is already resolved.
 *
 * Usage: bun fetch-existing.ts <pr-number> <out.json> [<own-login>]
 * Env:   GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY
 */

import type { Commenter, Existing, Threaded } from "./existing.ts";
import {
    graphqlFailure,
    graphql as request,
    requirePullNumber,
    requireRepository,
    restJson,
    tokenFromStdinOrEnv,
} from "./github.ts";
import { reason } from "./json.ts";

/**
 * The hidden marker on comments from the runs made while the plugin work was in progress,
 * and the only handle on the inline threads those runs left open.
 *
 * Change the string and those threads become unrecognisable, nothing is resolved, and
 * nothing reports a problem.
 */
const MARKER = "<!-- codeferret -->";

const [prNumber, outPath, ownArg] = process.argv.slice(2);
const own = (ownArg || "github-actions").replace(/\[bot\]$/, "");
const repo = process.env.GITHUB_REPOSITORY;
const token = await tokenFromStdinOrEnv();

if (!prNumber || !outPath || !token || !repo) {
    console.error("usage: bun fetch-existing.ts <pr-number> <out.json> [<own-login>]");
    console.error("env: GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY");
    process.exit(2);
}

const { owner, name } = requireRepository(repo);

requirePullNumber(prNumber);

interface GqlComment {
    author: { login: string } | null;
    authorAssociation: string;
    path: string;
    line: number | null;
    originalLine: number | null;
    url: string;
    body: string;
}

interface Page<T> {
    pageInfo: { hasNextPage: boolean; endCursor: string };
    nodes: T[];
}

interface GqlThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    comments: Page<GqlComment>;
}

const COMMENT_FIELDS = "author { login } authorAssociation path line originalLine url body";

const THREADS = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { ${COMMENT_FIELDS} }
          }
        }
      }
    }
  }
}`;

// The replies that settle a thread are its newest, and GraphQL returns them oldest first,
// so a thread cut at 100 loses exactly the comment that would make a finding `declined`.
const MORE_COMMENTS = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`;

/**
 * How far each of the paging loops below reads. Ten pages is a thousand threads, a thousand
 * comments on one thread, or a thousand conversation comments, each past anything a pull
 * request carries in practice.
 *
 * The cap is what stops a paging-ignoring response from filling memory in a step that holds
 * the tokens, and the threads are the larger half: each node carries up to a hundred comment
 * bodies. Every loop throws when it hits the cap, for the reason `fetchConversation` gives:
 * a list cut short in silence reads as a short list, and the comment that goes missing is a
 * decline that gets reposted.
 */
const MAX_PAGES = 10;

async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const result = await request(token, query, variables);
    const failure = graphqlFailure(result);

    if (failure) throw new Error(failure);

    return result.data;
}

async function threadPage(cursor: string | null): Promise<Page<GqlThread>> {
    const data = (await graphql(THREADS, { owner, name, number: Number(prNumber), cursor })) as {
        repository?: { pullRequest?: { reviewThreads?: Page<GqlThread> } };
    };

    const threads = data?.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error("no reviewThreads in response");

    return threads;
}

async function restOfThread(id: string, from: string): Promise<GqlComment[]> {
    const all: GqlComment[] = [];
    let cursor: string | null = from;

    for (let page = 1; cursor; page += 1) {
        if (page > MAX_PAGES) throw new Error(`thread ${id} is still going after ${MAX_PAGES} pages of comments`);

        const data = (await graphql(MORE_COMMENTS, { id, cursor })) as {
            node?: { comments?: Page<GqlComment> };
        };

        const next = data?.node?.comments;
        if (!next) break;

        all.push(...next.nodes);
        cursor = next.pageInfo.hasNextPage ? next.pageInfo.endCursor : null;
    }

    return all;
}

interface IssueComment {
    body: string;
    html_url: string;
    user: { login: string };
    author_association: string;
}

/**
 * The comments not anchored to a line.
 *
 * A failure comes back rather than being logged and swallowed. An empty list and a clean
 * exit is indistinguishable from a pull request nobody has commented on, so a finding
 * declined in a conversation comment would be reposted on every run with nothing saying
 * the fetch had failed. A 502 on page three is the same problem one step in.
 *
 * A conversation the cap cut short is the same problem again, so it throws. The comment a
 * fetch misses is a decline that gets reposted, and running out of pages in silence would
 * leave that reading as a short conversation.
 */
async function fetchConversation(): Promise<IssueComment[]> {
    const all: IssueComment[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const batch = (await restJson(
            token,
            `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
        )) as IssueComment[];

        all.push(...batch);
        if (batch.length < 100) return all;
    }

    throw new Error(`the conversation is still going after ${MAX_PAGES} pages of 100 comments`);
}

const raw: GqlThread[] = [];
let threadError: string | null = null;

try {
    let cursor: string | null = null;

    for (let page = 1; ; page += 1) {
        if (page > MAX_PAGES) throw new Error(`the review threads are still going after ${MAX_PAGES} pages`);

        const batch = await threadPage(cursor);
        raw.push(...batch.nodes);
        cursor = batch.pageInfo.hasNextPage ? batch.pageInfo.endCursor : null;

        if (!cursor) break;
    }

    for (const thread of raw) {
        if (thread.comments.pageInfo.hasNextPage) {
            thread.comments.nodes.push(...(await restOfThread(thread.id, thread.comments.pageInfo.endCursor)));
        }
    }
} catch (error) {
    // Not thrown, unlike the conversation fetch above: threads are the larger half and
    // throwing here would cost the review. The failure goes into the file instead, and that
    // half then counts as unread rather than as quiet, per orchestrator.md.
    threadError = reason(error);
    console.error(`could not list review threads: ${threadError}`);
}

// Both halves of `mine` are required.
//
// The login: `github-actions[bot]` is the identity of every workflow posting with
// `github.token`, so matching on it alone puts another workflow's threads on the list this
// run may resolve, and resolving takes that workflow's words off the page.
//
// The marker: an HTML comment renders as nothing, so anyone who can open a review thread can
// put it there and have this run adopt the thread. Resolving is the one non-model control on
// what gets taken off the page, so it is not opened to whoever can comment.
//
// A trailing `<sub>` category line used to count as a second shape here, for inline threads
// left by a released version. Nothing has been released, every thread this run has ever seen
// carries the marker, and ordinary markup proves nothing about who wrote a comment, in a
// test whose whole job is to be narrow.
const threads: Threaded[] = raw.map((t) => {
    const root = t.comments.nodes[0];
    const body = root?.body ?? "";
    const login = (root?.author?.login ?? "").replace(/\[bot\]$/, "");

    return {
        thread_id: t.id,
        resolved: t.isResolved,
        outdated: t.isOutdated,
        file: root?.path ?? "",
        line: root?.line ?? root?.originalLine ?? null,
        url: root?.url ?? "",
        mine: login === own && body.includes(MARKER),
        comments: t.comments.nodes.map((c) => ({
            author: c.author?.login ?? "unknown",
            association: c.authorAssociation,
            // The reply's own url, not the thread's. A decline cites one comment, and
            // post-review.ts reads that comment's association back to decide whether
            // whoever wrote it may settle anything.
            url: c.url ?? "",
            body: c.body,
        })),
    };
});

let conversation: Commenter[] = [];
let conversationError: string | null = null;

try {
    conversation = (await fetchConversation()).map((c) => ({
        author: c.user.login,
        association: c.author_association,
        body: c.body,
        url: c.html_url,
    }));
} catch (error) {
    conversationError = reason(error);
    console.error(`could not list the conversation: ${conversationError}`);
}

// Typed as the shape every reader declares, so a field renamed here stops compiling rather
// than reaching the vetting as an absence it cannot tell from "nobody said anything".
const written: Existing = {
    threads,
    conversation,
    ...(threadError ? { error: threadError } : {}),
    ...(conversationError ? { conversation_error: conversationError } : {}),
};

await Bun.write(outPath, `${JSON.stringify(written, null, 2)}\n`);

const mine = threads.filter((t) => t.mine).length;
const resolved = threads.filter((t) => t.resolved).length;
const answered = threads.filter((t) => (t.comments ?? []).length > 1).length;

console.log(
    `threads: ${threads.length} (${mine} mine, ${resolved} resolved, ${answered} answered)` +
        `  conversation comments: ${conversation.length}`,
);

if (threadError || conversationError) process.exit(1);

export {};
