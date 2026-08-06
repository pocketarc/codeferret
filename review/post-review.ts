#!/usr/bin/env bun
/**
 * Turn merged lens findings into one GitHub pull request review.
 *
 * One review, one body, no inline comments. What reads a review here is usually the agent
 * that will fix the findings, and it reads `findings.json` out of the run's artifact,
 * which holds every finding whole. Forty inline comments buy that reader nothing and bury
 * the pull request for everybody else. So the body carries what decides whether a person
 * stops to look: the summary, the counts, which lenses reported, the critical and high
 * findings in full, and a link to the run holding the rest.
 *
 * Once GitHub accepts the review, the findings file is rewritten with a `posted` record.
 * That is the only evidence anywhere that a run's findings were ever said out loud, and
 * `fetch-previous.ts` will not suppress a finding without it.
 *
 * Usage: bun post-review.ts <findings.json> <head-sha> <pr-number>
 * Env:   GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY
 *        GITHUB_SERVER_URL and GITHUB_RUN_ID link the run, when a runner sets them.
 */

import { dirname, join } from "node:path";
import { brokenLenses, commentUrls, partition, plural, vetDeclines } from "./findings.ts";
import type { Merged } from "./findings.ts";
import { graphql, graphqlFailure, requirePullNumber, requireRepository, rest, tokenFromStdinOrEnv } from "./github.ts";
import { reason } from "./json.ts";
import { composeReview, destinationOf, listedIn } from "./review-body.ts";

const [findingsPath, headSha, prNumber] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const token = await tokenFromStdinOrEnv();

if (!findingsPath || !headSha || !prNumber || !token || !repo) {
    console.error("usage: bun post-review.ts <findings.json> <head-sha> <pr-number>");
    console.error("env: GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY");
    process.exit(2);
}

requireRepository(repo);
requirePullNumber(prNumber);

const findingsFile: string = findingsPath;
const buildDir = dirname(findingsFile);

/**
 * What was already on the pull request when the run started, or nothing when the file is
 * missing or cannot be read.
 *
 * Read once. Two decisions rest on this file and both fail closed, so reading it twice
 * could resolve threads against one answer and reopen declines against another.
 */
async function readExisting(): Promise<unknown> {
    const file = Bun.file(join(buildDir, "existing.json"));

    if (!(await file.exists())) return {};

    try {
        return JSON.parse(await file.text());
    } catch {
        console.error("existing.json could not be read, so no thread is resolved and every decline is reopened.");
        return {};
    }
}

/** Threads this run posted itself, which are the only ones it may resolve. */
function ownThreads(existing: unknown): Set<string> {
    const parsed = (typeof existing === "object" && existing !== null ? existing : {}) as {
        threads?: Array<{ thread_id?: unknown; mine?: unknown }>;
    };

    return new Set(
        (parsed.threads ?? [])
            .filter((t) => t.mine === true && typeof t.thread_id === "string")
            .map((t) => String(t.thread_id)),
    );
}

let merged: Merged;

try {
    // Nothing has necessarily validated this file. The action runs check-findings.ts
    // first, but local-post.sh and the by-hand path in review/README.md both come
    // straight here, and an unhandled rejection at the end of a run that cost real money
    // is a worse answer than a sentence naming the file.
    merged = JSON.parse(await Bun.file(findingsFile).text()) as Merged;
} catch (error) {
    console.error(`${findingsFile}: ${reason(error)}`);
    console.error(`check it with: bun check-findings.ts ${findingsFile}`);
    process.exit(1);
}

if (typeof merged !== "object" || merged === null || !Array.isArray(merged.findings)) {
    console.error(`${findingsFile}: has no \`findings\` array`);
    console.error(`check it with: bun check-findings.ts ${findingsFile}`);
    process.exit(1);
}

const existing = await readExisting();

// The decision is taken again here rather than trusted: the orchestrator held the decline
// rule and the comments it judged as text in one context.
const vetted = vetDeclines(merged.findings, existing);

if (vetted.untraceable > 0) {
    console.error(
        `${plural(vetted.untraceable, "decline")} cited no comment from an owner, member or` +
            ` collaborator, and no resolved thread. Reporting them as new.`,
    );
}

// Counted apart from the rest, because this is the half of the rule a maintainer feels:
// a decline they meant, reopened because the comment behind it named nothing.
if (vetted.unrelated > 0) {
    console.error(
        `${plural(vetted.unrelated, "decline")} cited a comment that says nothing about the file` +
            ` the finding is in. Reporting them as new.`,
    );
}

// Partitioned once and handed to composeReview, so the counts in this log line and the
// counts in the body cannot come from two different derivations of the same findings.
const parts = partition(vetted.findings);
const { all: allFindings, fresh: findings, suppressed, declined } = parts;

/**
 * Record that this run's findings reached the pull request, and which one.
 *
 * fetch-previous.ts suppresses nothing on the strength of an artifact without this, so a
 * run that posts nothing because it had nothing new still writes one. Otherwise ten quiet
 * pushes put the last posted artifact past the point that script stops looking, and the
 * eleventh run raises the whole review again on a pull request that was already clean.
 *
 * The number is here because artifacts are found by head branch, and a branch name is
 * reused as soon as a merged branch is recreated and can head two open pull requests at
 * once. Without it, a review of one pull request silences findings on another.
 *
 * The findings written back are the vetted ones, not the orchestrator's. A decline
 * `vetDeclines` overturned was posted as new, and `fetch-previous.ts` reads this file into
 * the next run's `previous.json`, where a `declined` entry stays declined. Writing the
 * original array back would leave the artifact contradicting the review beside it and
 * re-suppress the finding the vetting exists to rescue.
 *
 * A failure to write it costs a repeated comment on the next run and nothing worse, so it
 * is logged rather than allowed to fail a job whose review has already landed.
 */
async function markPosted(url: string | null): Promise<void> {
    try {
        await Bun.write(
            findingsFile,
            `${JSON.stringify(
                { ...merged, findings: parts.all, posted: { at: new Date().toISOString(), url, pr: prNumber } },
                null,
                2,
            )}\n`,
        );
    } catch (error) {
        console.error(
            `${findingsFile} could not be marked as posted: ${reason(error)}.` +
                " The next run will raise these findings again.",
        );
    }
}

// Resolving is a write, so a dry run reports the decision without making it.
const mine = ownThreads(existing);
const asked = merged.resolve ?? [];

// `mine` is the non-model signal beside the orchestrator's judgement. fetch-existing.ts
// computes it, and has what a thread must carry to be marked. Resolving somebody else's
// thread takes their words off the page, and the next run reads a resolved thread back as
// a declined finding, so one wrong call suppresses a finding for good.
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

        const result = await graphql(
            token,
            `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`,
            { id: thread_id },
        );

        const failure = graphqlFailure(result);

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

        if (failure) {
            console.error(`could not resolve ${thread_id}: ${failure}`);
            continue;
        }

        resolved.push({ reason });
    }
}

const leftOpen = toResolve.length - resolved.length;
const broken = brokenLenses(merged.lens_health ?? []);
const to = destinationOf(process.env);
const listed = listedIn(findings, to);

const reviewBody = composeReview(
    merged,
    { resolved, resolveDenied, leftOpen, to, linkable: commentUrls(existing) },
    parts,
);

console.log(
    `total=${allFindings.length} new=${findings.length} suppressed=${suppressed.length}` +
        ` declined=${declined.length} listed=${listed.length} resolved=${resolved.length}/${asked.length}`,
);

// A run where every lens died also produces no findings, and posting nothing leaves the
// pull request looking reviewed and clean. So a failed lens is enough on its own to post:
// the body carries lens_health, which is the only place that failure becomes visible.
if (findings.length === 0 && broken.length === 0 && !process.env.DRY_RUN) {
    const accounted = suppressed.length + declined.length;
    console.log(
        accounted > 0
            ? `no new findings. ${suppressed.length} already commented on, ${declined.length} declined`
            : "no findings",
    );
    if (resolved.length > 0) console.log(`resolved ${plural(resolved.length, "thread")}`);

    // Nothing new to post is this run's whole review, and the record has to carry forward
    // or the chain of artifacts breaks. The four cases the `posted` rule exists for all
    // fail before this branch or instead of it.
    await markPosted(null);
    process.exit(0);
}

if (process.env.DRY_RUN) {
    console.log("\n===== REVIEW BODY =====\n");
    console.log(reviewBody);
    console.log("\n(dry run: nothing posted, 0 inline comments)");
    process.exit(0);
}

const response = await rest(token, `/repos/${repo}/pulls/${prNumber}/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commit_id: headSha, body: reviewBody, event: "COMMENT", comments: [] }),
});

const detail = await response.text();

if (!response.ok) {
    console.error(`review post failed (${response.status}): ${detail}`);
    process.exit(1);
}

// The review is posted by this point, so a body that is not the JSON we expect costs a
// URL in the log and nothing else. Throwing here would turn a landed review into a red job.
let created: { html_url?: string } = {};
try {
    created = JSON.parse(detail);
} catch {
    console.error(`the review posted, but its response body was not JSON: ${detail.slice(0, 200)}`);
}

// The action uploads on its last step, after this one, so the record is in the file by the
// time it is packed.
await markPosted(created.html_url ?? null);

console.log(`posted: ${created.html_url ?? "(no url returned)"}`);
