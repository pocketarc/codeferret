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

const [findingsPath, baseRef, headSha, prNumber] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

if (!findingsPath || !baseRef || !headSha || !prNumber || !token || !repo) {
    console.error("usage: bun post-review.ts <findings.json> <base-ref> <head-sha> <pr-number>");
    console.error("env: GITHUB_TOKEN, GITHUB_REPOSITORY");
    process.exit(2);
}

function severityRank(s: string): number {
    const i = SEVERITY_ORDER.indexOf(s);
    return i === -1 ? SEVERITY_ORDER.length : i;
}

/** Right-side line numbers per file that appear anywhere in the diff hunks. */
function commentableLines(): Map<string, Set<number>> {
    // Must stay the same pathspec build-prompts.sh gives the lenses, or a finding can
    // anchor to a file they never saw.
    const excludes = (process.env.EXCLUDE_PATHS ?? "")
        .split("\n")
        .map((g) => g.trim())
        .filter(Boolean)
        .map((g) => `:(exclude)${g}`);
    const pathspec = excludes.length > 0 ? ["--", ".", ...excludes] : [];

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
            currentFile = newFile[1] === "/dev/null" ? null : newFile[1];
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

const anchorable = commentableLines();

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

/** The plugin namespace is an implementation detail, so it is dropped for display. */
function lensLabel(lens: string): string {
    return lens.replace(/^[^:]+:/, "");
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function commentBody(f: Finding): string {
    return `**${f.title}**\n\n${f.body}\n\n<sub>${f.category}</sub>`;
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

const sections: string[] = ["## CodeFerret"];

if (merged.summary) sections.push(merged.summary);

sections.push(
    `**${plural(findings.length, "new finding")}**` +
        `${demoted.length > 0 ? ` · ${demoted.length} outside the diff, listed below` : ""}` +
        `${suppressed.length > 0 ? ` · ${suppressed.length} already commented on above` : ""}` +
        `${declined.length > 0 ? ` · ${declined.length} raised before and declined` : ""}`,
);

const health = merged.lens_health ?? [];
if (health.length > 0) {
    const broken = health.filter((h) => !h.ok);

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

    if (broken.length > 0) {
        sections.push(
            `> ${broken.length} of ${health.length} lenses did not report normally, so this review covers less than it appears to.`,
        );
    }

    const heading =
        broken.length > 0
            ? `${health.length} lenses ran, ${broken.length} needing attention`
            : `${health.length} lenses ran, all reporting`;

    sections.push(
        `<details${broken.length > 0 ? " open" : ""}>\n<summary>${heading}</summary>\n\n${items}\n</details>`,
    );
}

if (demoted.length > 0) {
    const body = demoted
        .map(
            (f) =>
                `- **\`${f.file}:${f.line}\`** — ${f.title}\n\n  ${f.body.replace(/\n/g, "\n  ")}` +
                `\n\n  <sub>${f.category}</sub>`,
        )
        .join("\n\n");
    sections.push(
        `### Findings outside the diff\n\nThese sit on lines this pull request did not change, so GitHub cannot anchor a comment to them.\n\n${body}`,
    );
}

if (suppressed.length > 0) {
    const body = suppressed
        .map(
            (f) =>
                `- \`${f.file}:${f.line}\` — ${f.title}` +
                `${f.existing_comment_url ? ` ([earlier comment](${f.existing_comment_url}))` : ""}`,
        )
        .join("\n");
    sections.push(
        `<details>\n<summary>${plural(suppressed.length, "finding")} already commented on</summary>\n\n${body}\n</details>`,
    );
}

if (declined.length > 0) {
    const body = declined
        .map(
            (f) =>
                `- \`${f.file}:${f.line}\` — ${f.title}` +
                `${f.existing_comment_url ? ` ([thread](${f.existing_comment_url}))` : ""}`,
        )
        .join("\n");
    sections.push(
        `<details>\n<summary>${plural(declined.length, "finding")} raised before and declined</summary>\n\n${body}\n</details>`,
    );
}

if (resolved.length > 0) {
    const body = resolved.map((r) => `- ${r.reason}`).join("\n");
    sections.push(
        `<details>\n<summary>${plural(resolved.length, "thread")} resolved</summary>\n\n${body}\n</details>`,
    );
}

if (resolveDenied) {
    sections.push(
        `> ${plural(toResolve.length, "thread")} look finished but could not be resolved:` +
            ` the workflow grants \`pull-requests: write\`, and \`resolveReviewThread\` needs` +
            ` \`contents: write\`.`,
    );
}

if (merged.notes) sections.push(`### Caveats\n\n${merged.notes}`);

let reviewBody = sections.join("\n\n");
if (reviewBody.length > MAX_BODY) {
    reviewBody = `${reviewBody.slice(0, MAX_BODY)}\n\n_(truncated)_`;
}

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
        ` resolved=${resolved.length}/${toResolve.length}`,
);

if (findings.length === 0 && !process.env.DRY_RUN) {
    const accounted = suppressed.length + declined.length;
    console.log(
        accounted > 0
            ? `no new findings — ${suppressed.length} already commented on, ${declined.length} declined`
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
    console.log(`(dry run — nothing posted; ${comments.length} inline comment(s))`);
    process.exit(0);
}

async function postReview(payload: unknown): Promise<Response> {
    return fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });
}

let response = await postReview({
    commit_id: headSha,
    body: reviewBody,
    event: "COMMENT",
    comments,
});

if (!response.ok && comments.length > 0) {
    // The reviews endpoint is all-or-nothing: one rejected anchor creates no comments.
    const detail = await response.text();
    console.error(`inline review rejected (${response.status}): ${detail}`);

    // A secondary rate limit is GitHub asking for a pause, not refusing the review. A
    // 90-finding run tripped it on 82 comments and fell straight through to the body,
    // which turns every anchored finding into a line in a wall of text over a wait
    // GitHub was willing to grant.
    if (response.status === 403 && /secondary rate limit/i.test(detail)) {
        console.error(`waiting ${RETRY_AFTER_MS / 1000}s, then trying the inline review once more`);
        await Bun.sleep(RETRY_AFTER_MS);

        response = await postReview({
            commit_id: headSha,
            body: reviewBody,
            event: "COMMENT",
            comments,
        });

        if (response.ok) {
            const created = (await response.json()) as { html_url?: string };
            console.log(`posted: ${created.html_url ?? "(no url returned)"}`);
            process.exit(0);
        }

        console.error(`inline review rejected again (${response.status})`);
    }

    console.error("retrying as a body-only review so the findings still land");

    const appendix = inline
        .map(
            (f) =>
                `- **\`${f.file}:${f.line}\`** — ${f.title}\n\n  ${f.body.replace(/\n/g, "\n  ")}` +
                `\n\n  <sub>${f.category}</sub>`,
        )
        .join("\n\n");

    response = await postReview({
        commit_id: headSha,
        body: `${reviewBody}\n\n### Findings\n\nGitHub rejected the inline anchors for this review, so they are listed here instead.\n\n${appendix}`.slice(
            0,
            MAX_BODY,
        ),
        event: "COMMENT",
    });
}

if (!response.ok) {
    console.error(`review post failed (${response.status}): ${await response.text()}`);
    process.exit(1);
}

const created = (await response.json()) as { html_url?: string };
console.log(`posted: ${created.html_url ?? "(no url returned)"}`);
