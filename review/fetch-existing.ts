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

import {
    graphqlFailure,
    graphql as request,
    requirePullNumber,
    requireRepository,
    restJson,
    tokenFromStdinOrEnv,
} from "./github.ts";
import { reason } from "./json.ts";

// The two constants below are the only handle on inline threads that earlier versions left
// open, on pull requests that are still open now. Change either string and those threads
// become unrecognisable, nothing is resolved, and nothing reports a problem.

/** The hidden marker on comments from the runs made while the plugin work was in progress. */
const MARKER = "<!-- codeferret -->";

/** The category trailer every released inline comment ended with. */
const RELEASED_TRAILER = /<sub>[^<]*<\/sub>\s*$/;

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

    while (cursor) {
        const data = (await graphql(MORE_COMMENTS, { id, cursor })) as {
            node?: { comments?: Page<GqlComment> };
        };

        const page = data?.node?.comments;
        if (!page) break;

        all.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
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
 */
async function fetchConversation(): Promise<IssueComment[]> {
    const all: IssueComment[] = [];

    for (let page = 1; ; page += 1) {
        const batch = (await restJson(
            token,
            `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
        )) as IssueComment[];

        all.push(...batch);
        if (batch.length < 100) return all;
    }
}

const raw: GqlThread[] = [];
let threadError: string | null = null;

try {
    let cursor: string | null = null;
    do {
        const page = await threadPage(cursor);
        raw.push(...page.nodes);
        cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    for (const thread of raw) {
        if (thread.comments.pageInfo.hasNextPage) {
            thread.comments.nodes.push(...(await restOfThread(thread.id, thread.comments.pageInfo.endCursor)));
        }
    }
} catch (error) {
    // Not thrown, unlike the conversation fetch above: threads are the larger half and
    // throwing here would cost the review. The failure goes into the file instead, where
    // orchestrator.md reads it and treats that half as unread rather than as quiet.
    threadError = reason(error);
    console.error(`could not list review threads: ${threadError}`);
}

// Both halves of `mine` are required.
//
// The login alone is not enough: `github-actions[bot]` is the identity of every workflow
// posting with `github.token`, so matching on it puts another workflow's threads on the
// list this run may resolve, and resolving takes that workflow's words off the page.
//
// Neither shape is enough alone either. An HTML comment renders as nothing, so anyone who
// can open a review thread can put the marker in it and have this run adopt the thread;
// `<sub>` is ordinary markup somebody could reach by accident. Resolving is the one
// non-model control on what gets taken off the page, so it is not opened to whoever can
// comment.
const threads = raw.map((t) => {
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
        mine: login === own && (body.includes(MARKER) || RELEASED_TRAILER.test(body)),
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

let conversation: Array<{ author: string; association: string; body: string; url: string }> = [];
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

await Bun.write(
    outPath,
    `${JSON.stringify(
        {
            threads,
            conversation,
            ...(threadError ? { error: threadError } : {}),
            ...(conversationError ? { conversation_error: conversationError } : {}),
        },
        null,
        2,
    )}\n`,
);

const mine = threads.filter((t) => t.mine).length;
const resolved = threads.filter((t) => t.resolved).length;
const answered = threads.filter((t) => t.comments.length > 1).length;

console.log(
    `threads: ${threads.length} (${mine} mine, ${resolved} resolved, ${answered} answered)` +
        `  conversation comments: ${conversation.length}`,
);

if (threadError || conversationError) process.exit(1);

export {};
