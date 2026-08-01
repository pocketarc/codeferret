#!/usr/bin/env bun
/**
 * Turn merged lens findings into one GitHub pull request review.
 *
 * POST /repos/{owner}/{repo}/pulls/{n}/reviews is atomic: a single comment anchored
 * to a line outside the diff fails the whole request with a 422 and nothing is
 * created. So every finding is checked against the diff hunks first, and anything
 * unanchorable moves into the review body instead of being dropped or gambled on.
 *
 * Usage: bun post-review.ts <findings.json> <base-ref> <head-sha> <pr-number>
 * Env:   GITHUB_TOKEN, GITHUB_REPOSITORY
 */

import { dirname, join } from "node:path";
import { MARKER, readDiffArgs } from "./lib.ts";
import {
    anchorable,
    anchorableLines,
    assemble,
    clamp,
    details,
    escapeInline,
    MAX_INLINE,
    mention,
    plural,
    rateLimitWait,
    severityRank,
} from "./review-body.ts";
import type { Finding, Listing, Merged, Section } from "./review-body.ts";

const [findingsPath, baseRef, headSha, prNumber] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

if (!findingsPath || !baseRef || !headSha || !prNumber || !token || !repo) {
    console.error("usage: bun post-review.ts <findings.json> <base-ref> <head-sha> <pr-number>");
    console.error("env: GITHUB_TOKEN, GITHUB_REPOSITORY");
    process.exit(2);
}

// Bound here rather than inside a function, because the check above narrows these only at
// this level: a function body could be called before it ran.
const buildDir = dirname(findingsPath);

/** Right-side line numbers per file that appear anywhere in the diff hunks. */
async function commentableLines(): Promise<Map<string, Set<number>>> {
    // The arguments are read back from the argv build-prompts.sh wrote for the lenses,
    // rather than built a second time here. Two constructions of them drift, and once they
    // do this map covers a diff no lens read, so a finding can be anchored inline against
    // a file nothing reviewed.
    let range: string;
    let pathspec: string[];

    try {
        ({ range, pathspec } = await readDiffArgs(join(buildDir, "diff-args")));
    } catch (error) {
        console.error(
            `${error instanceof Error ? error.message : String(error)}. findings.json has to sit in` +
                " the build directory of the run that produced it, beside the diff arguments its" +
                " lenses read under.",
        );
        process.exit(1);
    }

    // build-prompts.sh pins the head when the run starts, because a run takes tens of
    // minutes and whoever started it is often still committing. Anchoring against a
    // different commit puts a comment on the wrong line, or names a commit GitHub does not
    // hold, which fails the whole atomic review.
    const reviewed = range.includes("...") ? range.slice(range.lastIndexOf("...") + 3) : null;

    if (reviewed !== headSha) {
        console.error(
            `the lenses reviewed '${range}' and this was asked to anchor against '${headSha}'.` +
                " Run the review again against the commit you mean to post about.",
        );
        process.exit(1);
    }

    // The parser below reads git's default output shape, and a caller's own git config can
    // change it: `diff.noprefix` and `diff.mnemonicPrefix` both rewrite the `b/` this keys
    // on, `core.quotePath` backslash-quotes any path outside ASCII, and `diff.external`
    // replaces the format outright. Under any of them nothing matches, every finding is
    // demoted, and the review looks like one that anchored nothing on purpose. A runner
    // has no such config; the developer running local-post.sh does.
    const proc = Bun.spawnSync([
        "git",
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U3",
        `${baseRef}...${headSha}`,
        ...pathspec,
    ]);

    if (proc.exitCode !== 0) {
        throw new Error(`git diff failed: ${new TextDecoder().decode(proc.stderr)}`);
    }

    return anchorableLines(new TextDecoder().decode(proc.stdout));
}

/** Threads this run posted itself, which are the only ones it may resolve. */
async function ownThreads(): Promise<Set<string>> {
    const file = Bun.file(join(buildDir, "existing.json"));

    if (!(await file.exists())) return new Set();

    try {
        const parsed = JSON.parse(await file.text()) as {
            threads?: Array<{ thread_id?: unknown; mine?: unknown }>;
        };

        return new Set(
            (parsed.threads ?? [])
                .filter((t) => t.mine === true && typeof t.thread_id === "string")
                .map((t) => String(t.thread_id)),
        );
    } catch {
        console.error("existing.json could not be read, so no thread will be resolved.");
        return new Set();
    }
}

let merged: Merged;

try {
    // Nothing has necessarily validated this file. The action runs check-findings.ts
    // first, but local-post.sh and the by-hand path in review/README.md both come
    // straight here, and an unhandled rejection at the end of a run that cost real money
    // is a worse answer than a sentence naming the file.
    merged = JSON.parse(await Bun.file(findingsPath).text()) as Merged;
} catch (error) {
    console.error(`${findingsPath}: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`check it with: bun check-findings.ts ${findingsPath}`);
    process.exit(1);
}

if (typeof merged !== "object" || merged === null || !Array.isArray(merged.findings)) {
    console.error(`${findingsPath}: has no \`findings\` array`);
    console.error(`check it with: bun check-findings.ts ${findingsPath}`);
    process.exit(1);
}

const allFindings = [...merged.findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
);

// Keeping a count makes a matcher that eats findings visible.
const suppressed = allFindings.filter((f) => f.status === "already-reported");
const declined = allFindings.filter((f) => f.status === "declined");
const findings = allFindings.filter((f) => f.status !== "already-reported" && f.status !== "declined");

const anchors = await commentableLines();

const inline: Finding[] = [];
const demoted: Finding[] = [];

for (const finding of findings) {
    (anchorable(finding, anchors.get(finding.file)) ? inline : demoted).push(finding);
}

// GitHub counts every comment in a review as content created, and refuses a review
// carrying too many of them under a secondary rate limit. Ninety-five was refused twice,
// sixty seconds apart, and every comment was lost. Waiting does not fix it, so the batch
// stays under the limit and the rest go where an unanchorable finding already goes: the
// body. Findings are sorted by severity, so the ones that keep an anchor matter most.
const overflow = inline.splice(MAX_INLINE);

/** The plugin namespace is an implementation detail, so it is dropped for display. */
function lensLabel(lens: string): string {
    return lens.replace(/^[^:]+:/, "");
}

function commentBody(f: Finding): string {
    return `**${escapeInline(f.title)}**\n\n${f.body}\n\n_${f.category}_\n\n${MARKER}`;
}

// Resolving is a write, so a dry run reports the decision without making it.
const mine = await ownThreads();
const asked = merged.resolve ?? [];

// The orchestrator is told to leave a human's thread open, and that judgement is made in a
// session that has just read every comment on the pull request, written by anyone who can
// comment. `mine` is the non-model signal beside it: the login the review posts under, and
// the marker every comment of ours carries. Resolving somebody else's thread takes their
// words off the page, and the next run reads the resolved thread back as a declined
// finding, so one wrong call suppresses a finding for good.
const foreign = asked.filter((entry) => !mine.has(entry.thread_id));
const toResolve = asked.filter((entry) => mine.has(entry.thread_id));

if (foreign.length > 0) {
    console.error(
        `not resolving ${plural(foreign.length, "thread")} the orchestrator named but this run did not open:` +
            ` ${foreign.map((entry) => entry.thread_id).join(", ")}`,
    );
}

const resolved: Array<{ reason: string }> = [];
let resolveDenied = false;

if (toResolve.length > 0 && !process.env.DRY_RUN) {
    for (const { thread_id, reason } of toResolve) {
        if (resolveDenied) break;
        const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                query: `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`,
                variables: { id: thread_id },
            }),
        });

        const payload = (await response.json()) as { errors?: Array<{ message: string }> };

        const failure = payload.errors?.map((e) => e.message).join("; ");

        if (failure?.includes("not accessible by integration")) {
            // resolveReviewThread is gated on repository write, which pull-requests:
            // write does not grant.
            resolveDenied = true;
            console.error(
                `cannot resolve threads: the token lacks contents: write.` +
                    ` ${plural(toResolve.length - resolved.length, "thread")} were judged finished and left open.`,
            );
            continue;
        }

        if (!response.ok || failure) {
            console.error(`could not resolve ${thread_id}: ${failure ?? response.status}`);
            continue;
        }

        resolved.push({ reason });
    }
}

const leftOpen = toResolve.length - resolved.length;

const health = merged.lens_health ?? [];
const brokenLenses = health.filter((h) => !h.ok);

const counts = [`**${plural(findings.length, "new finding")}**`];
if (demoted.length > 0) counts.push(`${demoted.length} outside the diff, listed below`);
if (overflow.length > 0) counts.push(`${overflow.length} listed below rather than anchored`);
if (suppressed.length > 0) counts.push(`${suppressed.length} already commented on above`);
if (declined.length > 0) counts.push(`${declined.length} raised before and declined`);

const head: Section[] = ["## CodeFerret"];

if (merged.summary) head.push(clamp(merged.summary));

// A screen reader speaks a separator between joined counts as nothing, so five of them run
// into each other. Past one, they are a list.
const [onlyCount] = counts;
head.push(counts.length === 1 && onlyCount ? onlyCount : counts.map((c) => `- ${c}`).join("\n"));

if (health.length > 0) {
    // A list, not a table: GitHub gives a wide column the container and starves the
    // rest, and most lenses report no detail at all. Punctuation a screen reader speaks,
    // for the reason the counts above are a list.
    const items = health
        .map((h) => {
            const name = lensLabel(h.lens);
            const flag = h.ok ? "" : ", **needs attention**";
            const detail = h.detail ? `\n  ${h.detail.replace(/\n+/g, " ")}` : "";
            return `- **${name}**: ${plural(h.findings_returned, "finding")}${flag}${detail}`;
        })
        .join("\n");

    if (brokenLenses.length > 0) {
        head.push(
            `> ${brokenLenses.length} of ${health.length} lenses did not report normally, so this review covers less than it appears to.`,
        );
    }

    const heading =
        brokenLenses.length > 0
            ? `${health.length} lenses ran, ${brokenLenses.length} needing attention`
            : `${health.length} lenses ran, all reporting`;

    head.push(details(heading, items, brokenLenses.length > 0));
}

const tail: Section[] = [];

if (suppressed.length > 0) {
    tail.push(
        details(
            `${plural(suppressed.length, "finding")} already commented on`,
            suppressed.map((f) => mention(f, "earlier comment")).join("\n"),
        ),
    );
}

if (declined.length > 0) {
    tail.push(
        details(
            `${plural(declined.length, "finding")} raised before and declined`,
            declined.map((f) => mention(f, "thread")).join("\n"),
        ),
    );
}

if (resolved.length > 0) {
    tail.push(details(`${plural(resolved.length, "thread")} resolved`, resolved.map((r) => `- ${r.reason}`).join("\n")));
}

if (resolveDenied) {
    tail.push(
        `> ${plural(leftOpen, "thread")} look finished but could not be resolved:` +
            ` the workflow grants \`pull-requests: write\`, and \`resolveReviewThread\` needs` +
            ` \`contents: write\`.`,
    );
}

if (merged.notes) tail.push(`### Caveats\n\n${clamp(merged.notes)}`);

const outsideDiff: Listing = {
    heading: "Findings outside the diff",
    lead: "These sit on lines this pull request did not change, so GitHub cannot anchor a comment to them.",
    items: demoted,
};

const beyondTheLimit: Listing = {
    heading: `Findings beyond GitHub's comment limit`,
    lead: `A review carrying more than about ${MAX_INLINE} comments is refused outright, so these are here rather than on their lines.`,
    items: overflow,
};

const listings: Listing[] = [];
if (demoted.length > 0) listings.push(outsideDiff);
if (overflow.length > 0) listings.push(beyondTheLimit);

const reviewBody = assemble([...head, ...listings, ...tail]);

const comments = inline.map((f) => ({
    path: f.file,
    body: commentBody(f),
    side: "RIGHT" as const,
    ...(f.end_line && f.end_line !== f.line
        ? {
              start_line: Math.min(f.line, f.end_line),
              start_side: "RIGHT" as const,
              line: Math.max(f.line, f.end_line),
          }
        : { line: f.line }),
}));

console.log(
    `total=${allFindings.length} new=${findings.length} suppressed=${suppressed.length}` +
        ` declined=${declined.length} inline=${inline.length} demoted=${demoted.length}` +
        ` overflow=${overflow.length} resolved=${resolved.length}/${asked.length}`,
);

// A run where every lens died also produces no findings, and posting nothing leaves the
// pull request looking reviewed and clean. So a failed lens is enough on its own to post:
// the body carries lens_health, which is the only place that failure becomes visible.
if (findings.length === 0 && brokenLenses.length === 0 && !process.env.DRY_RUN) {
    const accounted = suppressed.length + declined.length;
    console.log(
        accounted > 0
            ? `no new findings. ${suppressed.length} already commented on, ${declined.length} declined`
            : "no findings",
    );
    if (resolved.length > 0) console.log(`resolved ${plural(resolved.length, "thread")}`);
    process.exit(0);
}

if (process.env.DRY_RUN) {
    console.log("\n===== REVIEW BODY =====\n");
    console.log(reviewBody);
    console.log("\n===== INLINE COMMENTS =====\n");
    for (const c of comments) {
        console.log(`--- ${c.path}:${"start_line" in c ? `${c.start_line}-${c.line}` : c.line}`);
        console.log(c.body);
        console.log();
    }
    console.log(`(dry run: nothing posted, ${plural(comments.length, "inline comment")})`);
    process.exit(0);
}

interface Posted {
    ok: boolean;
    status: number;
    detail: string;
    retryAfterMs: number | null;
}

async function postReview(payload: unknown): Promise<Posted> {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const detail = await response.text();

    return {
        ok: response.ok,
        status: response.status,
        detail,
        retryAfterMs: rateLimitWait(response.status, response.headers.get("retry-after"), detail),
    };
}

async function postWaitingOutALimit(payload: unknown, what: string): Promise<Posted> {
    const first = await postReview(payload);

    if (first.ok) return first;

    console.error(`${what} rejected (${first.status}): ${first.detail}`);

    if (first.retryAfterMs === null) return first;

    console.error(`waiting ${Math.round(first.retryAfterMs / 1000)}s, then trying the ${what} once more`);
    await Bun.sleep(first.retryAfterMs);

    const second = await postReview(payload);
    if (!second.ok) console.error(`${what} rejected again (${second.status}): ${second.detail}`);

    return second;
}

const inlineReview = { commit_id: headSha, body: reviewBody, event: "COMMENT", comments };

let response = await postWaitingOutALimit(inlineReview, "inline review");

if (!response.ok && comments.length > 0) {
    // The reviews endpoint is all-or-nothing: one rejected anchor creates no comments.
    console.error("retrying as a body-only review so the findings still land");

    // Nothing is on its own line in this path, so the overflow findings join the rescued
    // ones under a single heading. Two sibling sections here gave the reader two different
    // reasons for the same treatment.
    //
    // The rescued findings are assembled first, so the length goes to them before it goes
    // to anything else. Appending them to a body already at the limit is how the one path
    // that exists to save them was what dropped them.
    const rescued: Listing = {
        heading: "Findings",
        lead: "GitHub rejected the inline anchors for this review, so these are listed here instead.",
        items: [...inline, ...overflow],
    };

    response = await postWaitingOutALimit(
        {
            commit_id: headSha,
            body: assemble([...head, rescued, ...(demoted.length > 0 ? [outsideDiff] : []), ...tail]),
            event: "COMMENT",
        },
        "body-only review",
    );
}

if (!response.ok) {
    console.error(`review post failed (${response.status}): ${response.detail}`);
    process.exit(1);
}

// The review is posted by this point, so a body that is not the JSON we expect costs a
// URL in the log and nothing else. Throwing here would turn a landed review into a red job.
let created: { html_url?: string } = {};
try {
    created = JSON.parse(response.detail);
} catch {
    console.error(`the review posted, but its response body was not JSON: ${response.detail.slice(0, 200)}`);
}

console.log(`posted: ${created.html_url ?? "(no url returned)"}`);
