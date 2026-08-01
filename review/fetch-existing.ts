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

const [prNumber, outPath, ownArg] = process.argv.slice(2);
const own = (ownArg || "github-actions").replace(/\[bot\]$/, "");
const repo = process.env.GITHUB_REPOSITORY;

// Stdin is how run.sh passes it, so that the token is in no process's argument list.
// The environment variable is for running this by hand.
const token =
    process.env.GITHUB_TOKEN || (process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim());

if (!prNumber || !outPath || !token || !repo) {
    console.error("usage: bun fetch-existing.ts <pr-number> <out.json> [<own-login>]");
    console.error("env: GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY");
    process.exit(2);
}

const [owner, name] = repo.split("/");

interface GqlComment {
    author: { login: string } | null;
    authorAssociation: string;
    path: string;
    line: number | null;
    originalLine: number | null;
    url: string;
    body: string;
}

interface GqlThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    comments: { nodes: GqlComment[] };
}

const QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 100) {
            nodes { author { login } authorAssociation path line originalLine url body }
          }
        }
      }
    }
  }
}`;

async function graphql(cursor: string | null): Promise<{ nodes: GqlThread[]; next: string | null }> {
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            query: QUERY,
            variables: { owner, name, number: Number(prNumber), cursor },
        }),
    });

    const payload = (await response.json()) as {
        data?: {
            repository?: {
                pullRequest?: {
                    reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: GqlThread[] };
                };
            };
        };
        errors?: Array<{ message: string }>;
    };

    if (!response.ok || payload.errors) {
        throw new Error(payload.errors?.map((e) => e.message).join("; ") ?? `HTTP ${response.status}`);
    }

    const threads = payload.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) throw new Error("no reviewThreads in response");

    return { nodes: threads.nodes, next: threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null };
}

interface IssueComment {
    body: string;
    html_url: string;
    user: { login: string };
    author_association: string;
}

async function fetchConversation(): Promise<IssueComment[]> {
    const all: IssueComment[] = [];

    for (let page = 1; ; page += 1) {
        const response = await fetch(
            `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            },
        );

        if (!response.ok) {
            console.error(`could not list conversation (${response.status}): ${await response.text()}`);
            return all;
        }

        const batch = (await response.json()) as IssueComment[];
        all.push(...batch);
        if (batch.length < 100) return all;
    }
}

const raw: GqlThread[] = [];
let failure: string | null = null;

try {
    let cursor: string | null = null;
    do {
        const page = await graphql(cursor);
        raw.push(...page.nodes);
        cursor = page.next;
    } while (cursor);
} catch (error) {
    // Throwing here would cost the review, so the run carries on with what it has. The
    // failure is recorded in the file instead: an empty thread list and a clean exit is
    // indistinguishable from a pull request nobody has commented on, and the orchestrator
    // would then mark every finding new and repost the lot.
    failure = error instanceof Error ? error.message : String(error);
    console.error(`could not list review threads: ${failure}`);
}

// post-review.ts ends every inline comment with this. The login is not enough on its own:
// `github-actions[bot]` is the identity of every workflow posting with `github.token`, so
// matching on it alone puts another workflow's threads on the list of ones this run may
// resolve, and resolving takes that workflow's words off the page.
const MARKER = "<!-- codeferret -->";

const threads = raw.map((t) => {
    const root = t.comments.nodes[0];
    return {
        thread_id: t.id,
        resolved: t.isResolved,
        outdated: t.isOutdated,
        file: root?.path ?? "",
        line: root?.line ?? root?.originalLine ?? null,
        url: root?.url ?? "",
        mine:
            (root?.author?.login ?? "").replace(/\[bot\]$/, "") === own &&
            (root?.body ?? "").includes(MARKER),
        comments: t.comments.nodes.map((c) => ({
            author: c.author?.login ?? "unknown",
            association: c.authorAssociation,
            body: c.body,
        })),
    };
});

const conversation = (await fetchConversation()).map((c) => ({
    author: c.user.login,
    association: c.author_association,
    body: c.body,
    url: c.html_url,
}));

await Bun.write(
    outPath,
    `${JSON.stringify({ threads, conversation, ...(failure ? { error: failure } : {}) }, null, 2)}\n`,
);

const mine = threads.filter((t) => t.mine).length;
const resolved = threads.filter((t) => t.resolved).length;
const answered = threads.filter((t) => t.comments.length > 1).length;

console.log(
    `threads: ${threads.length} (${mine} mine, ${resolved} resolved, ${answered} answered)` +
        `  conversation comments: ${conversation.length}`,
);

if (failure) process.exit(1);
