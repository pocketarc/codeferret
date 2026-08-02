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
 * Env:   GITHUB_TOKEN, GITHUB_REPOSITORY
 *        GITHUB_SERVER_URL and GITHUB_RUN_ID link the run, when a runner sets them.
 */

import { dirname, join } from "node:path";
import { graphql, graphqlFailure, rest } from "./github.ts";
import { composeReview, LISTED, partition, plural } from "./review-body.ts";
import type { Merged } from "./review-body.ts";

const [findingsPath, headSha, prNumber] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

if (!findingsPath || !headSha || !prNumber || !token || !repo) {
    console.error("usage: bun post-review.ts <findings.json> <head-sha> <pr-number>");
    console.error("env: GITHUB_TOKEN, GITHUB_REPOSITORY");
    process.exit(2);
}

// Bound here rather than inside a function, because the check above narrows these only at
// this level: a function body could be called before it ran.
const buildDir = dirname(findingsPath);

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

const { all: allFindings, fresh: findings, suppressed, declined } = partition(merged.findings);

// Resolving is a write, so a dry run reports the decision without making it.
const mine = await ownThreads();
const asked = merged.resolve ?? [];

// The orchestrator is told to leave a human's thread open, and that judgement is made in a
// session that has just read every comment on the pull request, written by anyone who can
// comment. `mine` is the non-model signal beside it: the login the review posts under, and
// the shape an inline comment of ours ended in. Resolving somebody else's thread takes their
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
const brokenLenses = (merged.lens_health ?? []).filter((h) => !h.ok);
const listed = findings.filter((f) => LISTED.has(f.severity));

const reviewBody = composeReview(merged, { resolved, resolveDenied, leftOpen, env: process.env });

console.log(
    `total=${allFindings.length} new=${findings.length} suppressed=${suppressed.length}` +
        ` declined=${declined.length} listed=${listed.length} resolved=${resolved.length}/${asked.length}`,
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

// The record that this review reached the pull request, written into the one file every
// consumer keeps. The action uploads on its last step, after this one, so the record is in
// the file by the time it is packed. fetch-previous.ts will not suppress a finding on the
// strength of an artifact without it, for the reasons named at the top of that file.
//
// A failure to write it costs a repeated comment on the next run and nothing worse, so it
// is logged rather than allowed to fail a job whose review has already landed.
try {
    await Bun.write(
        findingsPath,
        `${JSON.stringify(
            { ...merged, posted: { at: new Date().toISOString(), url: created.html_url ?? null } },
            null,
            2,
        )}\n`,
    );
} catch (error) {
    console.error(
        `the review posted, but ${findingsPath} could not be marked as posted:` +
            ` ${error instanceof Error ? error.message : String(error)}.` +
            " The next run will raise these findings again.",
    );
}

console.log(`posted: ${created.html_url ?? "(no url returned)"}`);
