#!/usr/bin/env bun
/**
 * Collect the review comments CodeFerret has already posted on a pull request, so a
 * later run can avoid saying the same thing twice.
 *
 * Only comments by the posting identity count. A human's comment must never suppress a
 * finding.
 *
 * A comment whose `position` is null is outdated: GitHub collapses it because the line
 * it referred to has changed. Those are reported with `outdated: true`, because a
 * collapsed comment is invisible to the author, so a defect that survived the edit
 * still needs saying.
 *
 * Usage: bun fetch-existing.ts <pr-number> <out.json> [<author-login>]
 * Env:   GITHUB_TOKEN, GITHUB_REPOSITORY
 */

const [prNumber, outPath, authorArg] = process.argv.slice(2);
const author = authorArg || "github-actions[bot]";
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

if (!prNumber || !outPath || !token || !repo) {
    console.error("usage: bun fetch-existing.ts <pr-number> <out.json> [<author-login>]");
    console.error("env: GITHUB_TOKEN, GITHUB_REPOSITORY");
    process.exit(2);
}

interface ApiComment {
    path: string;
    line: number | null;
    original_line: number | null;
    position: number | null;
    body: string;
    html_url: string;
    user: { login: string };
}

const collected: ApiComment[] = [];

for (let page = 1; ; page += 1) {
    const response = await fetch(
        `https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100&page=${page}`,
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
        console.error(`could not list comments (${response.status}): ${await response.text()}`);
        break;
    }

    const batch = (await response.json()) as ApiComment[];
    collected.push(...batch);
    if (batch.length < 100) break;
}

const ours = collected.filter((c) => c.user.login === author);

const existing = ours.map((c) => ({
    file: c.path,
    line: c.line ?? c.original_line,
    outdated: c.position === null,
    url: c.html_url,
    body: c.body,
}));

await Bun.write(outPath, `${JSON.stringify({ existing }, null, 2)}\n`);

const outdated = existing.filter((c) => c.outdated).length;
console.log(
    `existing comments by ${author}: ${existing.length}` +
        ` (${outdated} outdated, treated as not covering)` +
        `${collected.length !== ours.length ? `; ignored ${collected.length - ours.length} from others` : ""}`,
);
