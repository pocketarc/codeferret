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
    status?: "new" | "already-reported";
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
    findings: Finding[];
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "nit", "question"];
const MAX_BODY = 60000;

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

// Counted rather than dropped, so a matcher that starts eating findings shows up as a
// number instead of as silence.
const suppressed = allFindings.filter((f) => f.status === "already-reported");
const findings = allFindings.filter((f) => f.status !== "already-reported");

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

// Severity and lens agreement stay out of the rendered comment on purpose; both are in
// findings.json. review/README.md has the reasoning and the run that produced it.
function commentBody(f: Finding): string {
    return `**${f.title}**\n\n${f.body}\n\n<sub>${f.category}</sub>`;
}

const sections: string[] = ["## CodeFerret"];

if (merged.summary) sections.push(merged.summary);

sections.push(
    `**${findings.length} new finding${findings.length === 1 ? "" : "s"}**` +
        `${demoted.length > 0 ? ` · ${demoted.length} outside the diff, listed below` : ""}` +
        `${suppressed.length > 0 ? ` · ${suppressed.length} already commented on above` : ""}`,
);

const health = merged.lens_health ?? [];
if (health.length > 0) {
    const rows = health
        .map(
            (h) =>
                `| \`${lensLabel(h.lens)}\` | ${h.findings_returned} | ${h.ok ? "ok" : "**needs attention**"} |` +
                ` ${h.detail ?? ""} |`,
        )
        .join("\n");
    sections.push(`| Lens | Findings | Status | Detail |\n|---|---|---|---|\n${rows}`);

    const broken = health.filter((h) => !h.ok);
    if (broken.length > 0) {
        sections.push(
            `> ${broken.length} lens(es) did not report normally, so this review is less complete than it looks.`,
        );
    }
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
        `<details>\n<summary>${suppressed.length} finding(s) already commented on in an earlier run</summary>\n\n${body}\n</details>`,
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
        ` inline=${inline.length} demoted=${demoted.length}`,
);

if (findings.length === 0 && !process.env.DRY_RUN) {
    console.log(
        suppressed.length > 0
            ? `no new findings — all ${suppressed.length} were commented on in an earlier run`
            : "no findings",
    );
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
