#!/usr/bin/env bun
/**
 * Turn merged lens findings into one GitHub pull request review.
 *
 * One review, one body, no inline comments. What reads a review here is usually the agent
 * that will fix the findings, and it reads `findings.json` out of the run's artifact,
 * which holds every finding whole. Forty inline comments buy that reader nothing and bury
 * the pull request for everybody else. So the body carries what decides whether a person
 * stops to look: the summary, the counts, which lenses reported, the full text of every
 * finding scored at the threshold or above, and a link to the run holding the rest.
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
 *        DRY_RUN=1 to print the review instead of posting it.
 */

import { dirname, join } from "node:path";
import { ownThreads, planResolution } from "./existing.ts";
import { partition } from "./findings.ts";
import { isTier, TIER_NAMES } from "./risk.ts";
import type { Tier } from "./risk.ts";
import { readMerged, REVIEW_THRESHOLD, runFacts, vetAgainstExisting } from "./read-run.ts";
import { graphql, graphqlFailure, requirePullNumber, requireRepository, rest, tokenFromStdinOrEnv } from "./github.ts";
import { reason } from "./json.ts";
import { reopenedReasons } from "./caveats.ts";
import { composeReview, destinationOf } from "./review-body.ts";
import { plural } from "./words.ts";

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

// Read once, and on the value rather than on the variable being set. `destinationOf` carries
// the first half of that rule for the variables it reads: a second reading is a second chance
// for the body and the log beside it to describe different reviews. The second half is the one
// build-prompts.sh writes down beside `INCLUDE_WORKING_TREE`: a model following
// commands/review.md composes this value and writes `DRY_RUN=0` rather than leaving it out,
// which a presence test reads as on. Anything else is refused here rather than guessed at,
// because guessing wrong on `DRY_RUN=true` posts the review somebody asked to have printed.
// Before the two GitHub reads below, so a misspelt value costs nothing.
const dryRunInput = process.env.DRY_RUN ?? "";

if (dryRunInput !== "" && dryRunInput !== "0" && dryRunInput !== "1") {
    console.error(`DRY_RUN is '${dryRunInput}'. It has to be 0 or 1.`);
    process.exit(2);
}

const dryRun = dryRunInput === "1";

// The `print-threshold` input, refused here rather than defaulted. A default is how this
// class of input has failed before: `resolve-threads` reached the orchestrator's prompt and
// nothing else, and the upload step read `artifact-path` while post-review.ts never saw it,
// so in both cases the run did something other than what the workflow asked for and nothing
// said so. An empty value is the action's own default arriving through a caller who set
// nothing, so it takes the default; a misspelling is a value somebody chose and got wrong.
const thresholdInput = process.env.PRINT_THRESHOLD ?? "";

if (thresholdInput !== "" && !isTier(thresholdInput)) {
    console.error(`PRINT_THRESHOLD is '${thresholdInput}'. It has to be one of ${TIER_NAMES.join(", ")}.`);
    process.exit(2);
}

const threshold: Tier = isTier(thresholdInput) ? thresholdInput : REVIEW_THRESHOLD;

const findingsFile: string = findingsPath;
const buildDir = dirname(findingsFile);

// An absolute path and the flag, because whoever reads this line is standing wherever the
// run left them, which for a session is the checkout under review, the directory bun takes a
// `bunfig.toml` from.
const merged = await readMerged(
    findingsFile,
    (line) => console.error(line),
    `check it with: bun --config=/dev/null ${join(import.meta.dir, "check-findings.ts")} ${findingsFile}`,
);

// The decision is taken again here: the orchestrator held the suppression rules and the
// comments it judged as text in one context.
const vetted = await vetAgainstExisting(
    merged.findings,
    buildDir,
    (line) => console.error(line),
    // Not the `print-threshold` input. That value decides what this run's comment prints, which
    // is a judgement about one page and is remade from scratch on the next push. This one
    // decides what it takes to dismiss a finding for good: `markPosted` writes the status into
    // the findings file, `fetch-previous.ts` reads it into the next run's `previous.json`, and
    // `previousOf` keeps a `declined` entry declined for the life of the pull request. Below
    // the bar a closed thread settles a finding on its own, and closing one takes repository
    // write or authorship of the pull request — so on an outside contributor's branch the
    // author can close threads on their own work. Wiring the input here made a consumer who
    // wanted a shorter comment widen that, silently: at `print-threshold: high` every medium
    // finding became dismissable by the author closing their own thread. Six lenses found it.
    REVIEW_THRESHOLD,
);
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

const asked = merged.resolve ?? [];

// Unset means off, so a caller who forgets to pass it closes no thread rather than closing
// one nobody sanctioned.
const mayResolve = process.env.RESOLVE_THREADS === "1";

if (!mayResolve && asked.length > 0) {
    console.error(
        `resolve-threads is off: not closing ${plural(asked.length, "thread")} the orchestrator judged finished.`,
    );
}

const { close: toResolve, foreign } = planResolution(asked, ownThreads(existing), mayResolve);

if (foreign.length > 0) {
    console.error(
        `not resolving ${plural(foreign.length, "thread")} the orchestrator named but this run did not open:` +
            ` ${foreign.map((entry) => entry.thread_id).join(", ")}`,
    );
}

const resolved: Array<{ reason: string }> = [];
let resolveDenied = false;

// Resolving is a write, so a dry run decides which threads to close and closes none. The
// entries still go in: `DRY_RUN=1` is documented as printing the review instead of posting it,
// and a body missing the `N threads resolved` block is not the body that would have gone out.
if (dryRun) {
    for (const { reason: why } of toResolve) resolved.push({ reason: why });
} else if (toResolve.length > 0) {
    for (const { thread_id, reason: why } of toResolve) {
        const result = await graphql(
            token,
            `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`,
            { id: thread_id },
        );

        const failure = graphqlFailure(result);

        if (failure?.includes("not accessible by integration")) {
            // resolveReviewThread requires repository write, which pull-requests: write
            // does not grant. The rest would fail the same way, so the loop stops here and
            // `leftOpen` below counts the threads it never reached.
            resolveDenied = true;
            break;
        }

        if (failure) {
            console.error(`could not resolve ${thread_id}: ${failure}`);
            continue;
        }

        resolved.push({ reason: why });
    }
}

const leftOpen = toResolve.length - resolved.length;

if (resolveDenied) {
    console.error(
        `cannot resolve threads: the token lacks contents: write.` +
            ` ${plural(leftOpen, "thread")} judged finished could not be resolved.`,
    );
}

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
        threshold,
        linkable: vetted.survey.linkable,
        ...(await runFacts(buildDir, existing)),
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
if (findings.length === 0 && !warned && !dryRun) {
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

if (dryRun) {
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
