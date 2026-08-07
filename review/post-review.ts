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
 *        ARTIFACT_HAS_FINDINGS=true where the run keeps findings.json for a reader.
 *        RESOLVE_THREADS=1 to close the threads the orchestrator judged finished.
 */

import { dirname, join } from "node:path";
import { ownThreads, unreadOf } from "./existing.ts";
import { partition, readMerged, vetAgainstExisting } from "./findings.ts";
import { graphql, graphqlFailure, requirePullNumber, requireRepository, rest, tokenFromStdinOrEnv } from "./github.ts";
import { reason } from "./json.ts";
import { composeReview, destinationOf, plural, reopenedReasons } from "./review-body.ts";
import { readDispatched } from "./run-files.ts";

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

// An absolute path and the flag, because whoever reads this line is standing wherever the
// run left them, which for a session is the checkout under review, the directory bun takes a
// `bunfig.toml` from.
const merged = await readMerged(
    findingsFile,
    `check it with: bun --config=/dev/null ${join(import.meta.dir, "check-findings.ts")} ${findingsFile}`,
);

// The decision is taken again here: the orchestrator held the suppression rules and the
// comments it judged as text in one context.
const vetted = await vetAgainstExisting(merged.findings, buildDir);
const existing = vetted.existing;

for (const said of reopenedReasons(vetted)) console.error(said);

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
 * The pull request number goes in because `postedFor` in previous.ts requires it, and that
 * function has why.
 *
 * The findings written back are the vetted ones, not the orchestrator's. A suppression
 * `vetSuppression` overturned was posted as new, and `fetch-previous.ts` reads this file
 * into the next run's `previous.json`, where a `declined` entry stays declined. Writing the
 * original array back would leave the artifact contradicting the review beside it and
 * re-suppress the finding the vetting exists to rescue.
 *
 * A failure to write it costs a repeated comment on the next run and nothing worse, so it
 * is only logged: the review that job posted has already landed.
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

const mine = ownThreads(existing);
const asked = merged.resolve ?? [];

// build-prompts.sh renders a different orchestrator prompt when `resolve-threads` is off,
// and a model can be talked out of a prompt. Unset means off, so a caller who forgets to
// pass it closes no thread rather than closing one nobody sanctioned.
const mayResolve = process.env.RESOLVE_THREADS === "1";

if (!mayResolve && asked.length > 0) {
    console.error(
        `resolve-threads is off: not closing ${plural(asked.length, "thread")} the orchestrator judged finished.`,
    );
}

// `mine` is the non-model signal beside the orchestrator's judgement. fetch-existing.ts
// computes it, and has what a thread must carry to be marked. Resolving somebody else's
// thread takes their words off the page, and the next run reads a resolved thread back as
// a declined finding, so one wrong call suppresses a finding for good.
const foreign = mayResolve ? asked.filter((entry) => !mine.has(entry.thread_id)) : [];
const toResolve = mayResolve ? asked.filter((entry) => mine.has(entry.thread_id)) : [];

if (foreign.length > 0) {
    console.error(
        `not resolving ${plural(foreign.length, "thread")} the orchestrator named but this run did not open:` +
            ` ${foreign.map((entry) => entry.thread_id).join(", ")}`,
    );
}

const resolved: Array<{ reason: string }> = [];
let resolveDenied = false;

// Resolving is a write, so a dry run reports the decision without making it.
if (toResolve.length > 0 && !process.env.DRY_RUN) {
    for (const { thread_id, reason: why } of toResolve) {
        if (resolveDenied) break;

        const result = await graphql(
            token,
            `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`,
            { id: thread_id },
        );

        const failure = graphqlFailure(result);

        if (failure?.includes("not accessible by integration")) {
            // resolveReviewThread requires repository write, which pull-requests: write
            // does not grant.
            resolveDenied = true;
            console.error(
                `cannot resolve threads: the token lacks contents: write.` +
                    ` ${plural(toResolve.length - resolved.length, "thread")} judged finished could not be resolved.`,
            );
            continue;
        }

        if (failure) {
            console.error(`could not resolve ${thread_id}: ${failure}`);
            continue;
        }

        resolved.push({ reason: why });
    }
}

const leftOpen = toResolve.length - resolved.length;
const to = destinationOf(process.env);

const {
    body: reviewBody,
    listed,
    warned,
} = composeReview(
    merged,
    {
        resolved,
        resolveDenied,
        leftOpen,
        to,
        linkable: vetted.survey.linkable,
        unread: unreadOf(existing),
        dispatched: await readDispatched(buildDir),
    },
    parts,
);

console.log(
    `total=${allFindings.length} new=${findings.length} suppressed=${suppressed.length}` +
        ` declined=${declined.length} listed=${listed.length} resolved=${resolved.length}/${asked.length}`,
);

// A run where every lens died also produces no findings, and posting nothing leaves the pull
// request looking reviewed and clean. So a body carrying a warning about its own coverage is
// enough on its own to post, whatever it found: the review is the only place those warnings
// are read. The job log carries them too, and the person the caveats are for never opens it.
if (findings.length === 0 && !warned && !process.env.DRY_RUN) {
    const accounted = suppressed.length + declined.length;
    console.log(
        accounted > 0
            ? `no new findings. ${suppressed.length} already commented on, ${declined.length} declined`
            : "no findings",
    );
    if (resolved.length > 0) console.log(`resolved ${plural(resolved.length, "thread")}`);

    // Nothing new to post is this run's whole review, and the record has to carry forward
    // or the chain of artifacts breaks. The cases the `posted` rule exists for all fail
    // before this branch or instead of it.
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
