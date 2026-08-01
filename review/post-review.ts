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

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

interface Finding {
    found_by?: string[];
    file: string;
    line: number;
    end_line?: number;
    severity: string;
    category: string;
    title: string;
    body: string;
    in_diff?: boolean;
    status?: "new" | "already-reported" | "declined";
    existing_comment_url?: string;
}

interface LensHealth {
    lens: string;
    findings_returned: number;
    ok: boolean;
    detail?: string;
}

interface Merged {
    summary?: string;
    notes?: string;
    lens_health?: LensHealth[];
    resolve?: Array<{ thread_id: string; reason: string }>;
    findings: Finding[];
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "nit", "question"];
const MAX_BODY = 60000;
const RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_INLINE = 40;

// The orchestrator writes both of these, and nothing bounds what a model produces. Left
// unbounded, a runaway summary eats the length the findings need.
const MAX_PROSE = 4000;

const [findingsPath, baseRef, headSha, prNumber] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

if (!findingsPath || !baseRef || !headSha || !prNumber || !token || !repo) {
    console.error("usage: bun post-review.ts <findings.json> <base-ref> <head-sha> <pr-number>");
    console.error("env: GITHUB_TOKEN, GITHUB_REPOSITORY");
    process.exit(2);
}

// Bound here rather than inside commentableLines, because the check above narrows these
// only at this level: a function body could be called before it ran.
const buildDir = dirname(findingsPath);

function severityRank(s: string): number {
    const i = SEVERITY_ORDER.indexOf(s);
    return i === -1 ? SEVERITY_ORDER.length : i;
}

/** Right-side line numbers per file that appear anywhere in the diff hunks. */
async function commentableLines(): Promise<Map<string, Set<number>>> {
    // The pathspec is read back from the argv build-prompts.sh wrote for the lenses,
    // rather than built a second time here. Two constructions of it drift, and once they
    // do this map covers files no lens read, so a finding can be anchored inline against
    // a file nothing reviewed. Element one is the range, which this script takes from its
    // own arguments; everything after it is the pathspec.
    const argsFile = join(buildDir, "diff-args");

    if (!existsSync(argsFile)) {
        console.error(
            `no ${argsFile}. findings.json has to sit in the build directory of the run that produced it,` +
                " beside the diff arguments its lenses read under.",
        );
        process.exit(1);
    }

    const pathspec = (await Bun.file(argsFile).text()).split("\0").filter(Boolean).slice(1);

    const proc = Bun.spawnSync(["git", "diff", "-U3", `${baseRef}...${headSha}`, ...pathspec]);

    if (proc.exitCode !== 0) {
        throw new Error(`git diff failed: ${new TextDecoder().decode(proc.stderr)}`);
    }

    const byFile = new Map<string, Set<number>>();
    let currentFile: string | null = null;
    let rightLine = 0;

    for (const line of new TextDecoder().decode(proc.stdout).split("\n")) {
        const newFile = line.match(/^\+\+\+ b\/(.*)$/);
        if (newFile) {
            const named = newFile[1];
            currentFile = named === undefined || named === "/dev/null" ? null : named;
            if (currentFile && !byFile.has(currentFile)) byFile.set(currentFile, new Set());
            continue;
        }

        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            rightLine = Number(hunk[1]);
            continue;
        }

        if (!currentFile || line.startsWith("-")) continue;
        if (line.startsWith("+") || line.startsWith(" ")) {
            byFile.get(currentFile)?.add(rightLine);
            rightLine += 1;
        }
    }

    return byFile;
}

const merged: Merged = JSON.parse(await Bun.file(findingsPath).text());
const allFindings = [...(merged.findings ?? [])].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
);

// Keeping a count makes a matcher that eats findings visible.
const suppressed = allFindings.filter((f) => f.status === "already-reported");
const declined = allFindings.filter((f) => f.status === "declined");
const findings = allFindings.filter((f) => f.status !== "already-reported" && f.status !== "declined");

const anchorable = await commentableLines();

const inline: Finding[] = [];
const demoted: Finding[] = [];

for (const finding of findings) {
    const fileLines = anchorable.get(finding.file);
    const start = finding.end_line ? Math.min(finding.line, finding.end_line) : finding.line;
    const end = finding.end_line ? Math.max(finding.line, finding.end_line) : finding.line;

    let ok = fileLines !== undefined;
    for (let n = start; ok && n <= end; n += 1) {
        if (!fileLines?.has(n)) ok = false;
    }

    (ok ? inline : demoted).push(finding);
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

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// `github-actions[bot]` is the login of every workflow posting with `github.token`, so a
// later run cannot tell its own threads from another workflow's by author. This marker
// renders as nothing and is what fetch-existing.ts matches on.
const MARKER = "<!-- codeferret -->";

function commentBody(f: Finding): string {
    return `**${f.title}**\n\n${f.body}\n\n_${f.category}_\n\n${MARKER}`;
}

/**
 * One finding as a bullet, for the sections of the body that list findings rather than
 * anchor them.
 *
 * The continuation indent is two spaces. Four after a blank line is an indented code
 * block in markdown, which takes the formatting out of the body and stops it wrapping.
 */
function bullet(f: Finding): string {
    const span = f.end_line && f.end_line !== f.line ? `${f.line}-${f.end_line}` : `${f.line}`;
    const body = f.body.replace(/\n/g, "\n  ");

    return `- **${f.title}**\n\n  \`${f.file}:${span}\`\n\n  ${body}\n\n  _${f.category}_`;
}

/** One finding as a single line, for the sections that only say a finding was seen. */
function mention(f: Finding, link: string): string {
    const url = f.existing_comment_url ? ` ([${link}](${f.existing_comment_url}))` : "";
    return `- ${f.title} (\`${f.file}:${f.line}\`)${url}`;
}

/** Prose the orchestrator wrote, cut to a length the findings can still fit around. */
function clamp(prose: string): string {
    return prose.length <= MAX_PROSE ? prose : `${prose.slice(0, MAX_PROSE)}\n\n_(cut for length)_`;
}

// Resolving is a write, so a dry run reports the decision without making it.
const toResolve = merged.resolve ?? [];
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
                    ` ${plural(toResolve.length, "thread")} were judged finished and left open.`,
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

/** A heading, a reason, and findings listed under it. The only sections that can run long. */
interface Listing {
    heading: string;
    lead: string;
    items: Finding[];
}

type Section = string | Listing;

function isListing(section: Section): section is Listing {
    return typeof section !== "string";
}

/**
 * Join the sections into one body no longer than GitHub accepts.
 *
 * Everything except the finding listings is short, and it is the part that makes the
 * review honest: the counts, the lens health, what was suppressed, and the caveats saying
 * what the run could not check. So the listings get whatever length the rest leaves, and
 * they lose whole findings from the end rather than being cut at a character offset. An
 * offset lands inside a `<details>`, a fenced block, or a finding's own markup, and
 * GitHub renders the wreckage. What did not fit is counted and pointed at the artifact.
 *
 * Listings are filled in the order given, so put the one that matters most first.
 */
function assemble(sections: Section[]): string {
    const fixed = sections.filter((s) => !isListing(s)) as string[];
    let budget = MAX_BODY - fixed.reduce((total, s) => total + s.length + 2, 0);

    const rendered = sections.map((section) => {
        if (!isListing(section)) return section;

        const frame = `### ${section.heading}\n\n${section.lead}\n\n`;
        // Reserved for the omission line, so saying what went missing cannot itself be
        // the thing that does not fit.
        budget -= frame.length + 200;

        const kept: string[] = [];
        for (const finding of section.items) {
            const text = bullet(finding);
            if (text.length + 2 > budget) break;
            kept.push(text);
            budget -= text.length + 2;
        }

        const missing = section.items.length - kept.length;
        const omission =
            missing > 0
                ? `\n\n- _${plural(missing, "further finding")} left out for length. Every one of them is in \`findings.json\` in the \`codeferret-run\` artifact._`
                : "";

        return `${frame}${kept.join("\n\n")}${omission}`;
    });

    const body = rendered.join("\n\n");

    // Reached only when the short sections alone exceed the limit, which takes a
    // lens_health list or a suppressed list of a size nothing here has seen.
    return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n_(cut for length)_` : body;
}

const health = merged.lens_health ?? [];
const brokenLenses = health.filter((h) => !h.ok);

const counts = [`**${plural(findings.length, "new finding")}**`];
if (demoted.length > 0) counts.push(`${demoted.length} outside the diff, listed below`);
if (overflow.length > 0) counts.push(`${overflow.length} listed below rather than anchored`);
if (suppressed.length > 0) counts.push(`${suppressed.length} already commented on above`);
if (declined.length > 0) counts.push(`${declined.length} raised before and declined`);

const head: Section[] = ["## CodeFerret"];

if (merged.summary) head.push(clamp(merged.summary));

// One clause reads as a sentence. Five joined by a separator wrap wherever GitHub's
// column ends, and a screen reader speaks the separator as nothing, so the counts run
// into each other. Past one, they are a list.
const [onlyCount] = counts;
head.push(counts.length === 1 && onlyCount ? onlyCount : counts.map((c) => `- ${c}`).join("\n"));

if (health.length > 0) {
    // A list, not a table: GitHub gives a wide column the container and starves the
    // rest, and most lenses report no detail at all.
    const items = health
        .map((h) => {
            const name = lensLabel(h.lens);
            const flag = h.ok ? "" : " · **needs attention**";
            const detail = h.detail ? `\n  ${h.detail.replace(/\n+/g, " ")}` : "";
            return `- **${name}** · ${plural(h.findings_returned, "finding")}${flag}${detail}`;
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

    head.push(
        `<details${brokenLenses.length > 0 ? " open" : ""}>\n<summary>${heading}</summary>\n\n${items}\n</details>`,
    );
}

const tail: Section[] = [];

if (suppressed.length > 0) {
    const body = suppressed.map((f) => mention(f, "earlier comment")).join("\n");
    tail.push(
        `<details>\n<summary>${plural(suppressed.length, "finding")} already commented on</summary>\n\n${body}\n</details>`,
    );
}

if (declined.length > 0) {
    const body = declined.map((f) => mention(f, "thread")).join("\n");
    tail.push(
        `<details>\n<summary>${plural(declined.length, "finding")} raised before and declined</summary>\n\n${body}\n</details>`,
    );
}

if (resolved.length > 0) {
    const body = resolved.map((r) => `- ${r.reason}`).join("\n");
    tail.push(
        `<details>\n<summary>${plural(resolved.length, "thread")} resolved</summary>\n\n${body}\n</details>`,
    );
}

if (resolveDenied) {
    tail.push(
        `> ${plural(toResolve.length, "thread")} look finished but could not be resolved:` +
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
        ` overflow=${overflow.length} resolved=${resolved.length}/${toResolve.length}`,
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

/**
 * A secondary rate limit comes back as 403 or 429, and both carry `retry-after`. Match only
 * one of those statuses, or sleep a fixed minute of our own, and the retry goes out after a
 * minute against a limit that asked for two: the wait is spent and it is refused again.
 */
function rateLimitWait(response: Response, detail: string): number | null {
    const limited =
        response.status === 429 || (response.status === 403 && /secondary rate limit/i.test(detail));

    if (!limited) return null;

    const asked = Number(response.headers.get("retry-after")) * 1000;
    return asked > 0 ? Math.min(asked, MAX_RETRY_AFTER_MS) : RETRY_AFTER_MS;
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
        retryAfterMs: rateLimitWait(response, detail),
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

    // The rescued findings are assembled first, so the length goes to them before it goes
    // to anything else. Appending them to a body already at the limit is how the one path
    // that exists to save them was what dropped them.
    const rescued: Listing = {
        heading: "Findings",
        lead: "GitHub rejected the inline anchors for this review, so these are listed here instead.",
        items: inline,
    };

    response = await postWaitingOutALimit(
        {
            commit_id: headSha,
            body: assemble([...head, rescued, ...listings, ...tail]),
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
