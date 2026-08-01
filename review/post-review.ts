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
 * Usage: bun post-review.ts <findings.json> <head-sha> <pr-number>
 * Env:   GITHUB_TOKEN, GITHUB_REPOSITORY
 *        GITHUB_SERVER_URL and GITHUB_RUN_ID link the run, when a runner sets them.
 */

import { dirname, join } from "node:path";
import {
    assemble,
    clamp,
    details,
    escapeInline,
    LISTED,
    mention,
    plural,
    runUrl,
    severityRank,
} from "./review-body.ts";
import type { Listing, Merged } from "./review-body.ts";

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

const allFindings = [...merged.findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
);

// Keeping a count makes a matcher that eats findings visible.
const suppressed = allFindings.filter((f) => f.status === "already-reported");
const declined = allFindings.filter((f) => f.status === "declined");
const findings = allFindings.filter((f) => f.status !== "already-reported" && f.status !== "declined");

/** The plugin namespace is an implementation detail, so it is dropped for display. */
function lensLabel(lens: string): string {
    return lens.replace(/^[^:]+:/, "");
}

// Resolving is a write, so a dry run reports the decision without making it.
const mine = await ownThreads();
const asked = merged.resolve ?? [];

// The orchestrator is told to leave a human's thread open, and that judgement is made in a
// session that has just read every comment on the pull request, written by anyone who can
// comment. `mine` is the non-model signal beside it: the login the review posts under, and
// the marker every comment of ours carried. Resolving somebody else's thread takes their
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
if (suppressed.length > 0) counts.push(`${suppressed.length} already commented on above`);
if (declined.length > 0) counts.push(`${declined.length} raised before and declined`);

const head: string[] = ["## CodeFerret"];

if (merged.summary) head.push(clamp(merged.summary));

// A screen reader speaks a separator between joined counts as nothing, so three of them
// run into each other. Past one, they are a list.
const [onlyCount] = counts;
head.push(counts.length === 1 && onlyCount ? onlyCount : counts.map((c) => `- ${c}`).join("\n"));

if (health.length > 0) {
    // A list, not a table: GitHub gives a wide column the container and starves the
    // rest, and most lenses report no detail at all. Punctuation a screen reader speaks,
    // for the reason the counts above are a list.
    const items = health
        .map((h) => {
            const name = escapeInline(lensLabel(h.lens));
            const flag = h.ok ? "" : ", **needs attention**";
            // Escaped because this list sits inside the `<details>` block below it, and a
            // lens that reports what it could not check writes about markup. One wrote
            // "the native <details> disclosures", which opens a second block whose close
            // takes the outer one's `</details>`, and the rest of the review disappears
            // into it.
            const detail = h.detail ? `\n  ${escapeInline(h.detail.replace(/\n+/g, " "))}` : "";
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

const tail: string[] = [];

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
        `> ${plural(leftOpen, "thread")} judged finished could not be resolved:` +
            ` the workflow grants \`pull-requests: write\`, and \`resolveReviewThread\` needs` +
            ` \`contents: write\`.`,
    );
}

if (merged.notes) tail.push(`### Caveats\n\n${clamp(merged.notes)}`);

// The whole review is in findings.json, so the body names where that file is rather than
// reprinting it. Without a run to link, the sentence still has to say which file, because
// a reader who cannot follow a link still needs to know what to ask for.
const run = runUrl(process.env);
const holdsEveryOne = run
    ? `\`findings.json\` in the \`codeferret-run\` artifact of [this run](${run}) holds every one`
    : "`findings.json` in the run's build directory holds every one";

const listed = findings.filter((f) => LISTED.has(f.severity));

const listing: Listing | null =
    findings.length === 0
        ? null
        : {
              heading: listed.length > 0 ? "Critical and high findings" : "Findings",
              lead:
                  listed.length > 0
                      ? `${listed.length} of ${plural(findings.length, "finding")}. ${holdsEveryOne}.`
                      : `No finding is critical or high. ${holdsEveryOne}.`,
              items: listed,
          };

const reviewBody = assemble(head, listing, tail);

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

const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, {
    method: "POST",
    headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
    },
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

console.log(`posted: ${created.html_url ?? "(no url returned)"}`);
