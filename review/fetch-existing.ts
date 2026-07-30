#!/usr/bin/env bun
/**
 * Collect the discussion already on a pull request: every review comment with its
 * replies, and the conversation comments that are not anchored to a line.
 *
 * Every author counts. A finding a human already raised does not need raising again, and
 * a reply is where the answer to a finding lives.
 *
 * Usage: bun fetch-existing.ts <pr-number> <out.json> [<own-login>]
 * Env:   GITHUB_TOKEN, GITHUB_REPOSITORY
 */

const [prNumber, outPath, ownArg] = process.argv.slice(2);
const own = ownArg || "github-actions[bot]";
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

if (!prNumber || !outPath || !token || !repo) {
    console.error("usage: bun fetch-existing.ts <pr-number> <out.json> [<own-login>]");
    console.error("env: GITHUB_TOKEN, GITHUB_REPOSITORY");
    process.exit(2);
}

interface ApiComment {
    id: number;
    in_reply_to_id?: number;
    path: string;
    line: number | null;
    original_line: number | null;
    position: number | null;
    body: string;
    html_url: string;
    user: { login: string };
}

interface IssueComment {
    body: string;
    html_url: string;
    user: { login: string };
}

async function collect<T>(path: string): Promise<T[]> {
    const all: T[] = [];

    for (let page = 1; ; page += 1) {
        const response = await fetch(
            `https://api.github.com/repos/${repo}/${path}?per_page=100&page=${page}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            },
        );

        if (!response.ok) {
            // An empty list costs duplicate comments; a thrown error costs the review.
            console.error(`could not list ${path} (${response.status}): ${await response.text()}`);
            return all;
        }

        const batch = (await response.json()) as T[];
        all.push(...batch);
        if (batch.length < 100) return all;
    }
}

const reviewComments = await collect<ApiComment>(`pulls/${prNumber}/comments`);
const issueComments = await collect<IssueComment>(`issues/${prNumber}/comments`);

const roots = reviewComments.filter((c) => c.in_reply_to_id === undefined);

const threads = roots.map((root) => ({
    file: root.path,
    line: root.line ?? root.original_line,
    // GitHub collapses a comment when the line it referred to changes, so the author
    // cannot see it.
    outdated: root.position === null,
    url: root.html_url,
    author: root.user.login,
    mine: root.user.login === own,
    body: root.body,
    replies: reviewComments
        .filter((c) => c.in_reply_to_id === root.id)
        .map((c) => ({ author: c.user.login, body: c.body, url: c.html_url })),
}));

const conversation = issueComments.map((c) => ({
    author: c.user.login,
    body: c.body,
    url: c.html_url,
}));

await Bun.write(outPath, `${JSON.stringify({ threads, conversation }, null, 2)}\n`);

const mine = threads.filter((t) => t.mine).length;
const withReplies = threads.filter((t) => t.replies.length > 0).length;
const outdated = threads.filter((t) => t.outdated).length;

console.log(
    `threads: ${threads.length} (${mine} mine, ${withReplies} answered, ${outdated} outdated)` +
        `  conversation comments: ${conversation.length}`,
);
