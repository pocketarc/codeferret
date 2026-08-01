#!/usr/bin/env bun
/**
 * Fetch the findings the previous run left behind, so this run can tell a finding it has
 * already reported from one nobody has seen.
 *
 * Every push re-runs the whole review. A review is one body now, and a review body is
 * neither a review thread nor a conversation comment, so nothing fetch-existing.ts reads
 * carries what the last run said: without this, every finding is raised again on every
 * push for ever. The run's own findings file is the record instead, and the workflow
 * uploads it as the `codeferret-run` artifact.
 *
 * Reading an artifact needs `actions: read`, which the shipped workflow does not grant. So
 * every failure here is a line on stderr and a file holding no findings. No permission, no
 * artifact, a retention window that has closed, and a first run all mean the same thing to
 * the orchestrator: every finding is new. That is what happened before this script existed,
 * so nothing is worse off for the permission being absent.
 *
 * The newest artifact wins, whatever its run concluded. A run that ends red still posts its
 * review: check-findings.ts drops what it cannot use, the review lands, and the job goes red
 * over what was dropped. Those findings were said, so they count as said.
 *
 * Usage: bun fetch-previous.ts <pr-number> <out.json>
 * Env:   GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY, GITHUB_RUN_ID
 */

import { readFromZip } from "./unzip.ts";

/** The name the shipped workflow gives the upload. A repository that renames it opts out. */
const ARTIFACT = "codeferret-run";

/** Artifacts are listed newest first, so this is how far back a busy repository is searched. */
const MAX_PAGES = 5;
const PER_PAGE = 100;

/** Big enough for a whole build directory, small enough that a runner cannot be made to fetch a disk. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const [prNumber, outPath] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;

// Stdin is how run.sh passes it, so that the token is in no process's argument list.
// The environment variable is for running this by hand.
const token =
    process.env.GITHUB_TOKEN || (process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim());

if (!prNumber || !outPath || !token || !repo) {
    console.error("usage: bun fetch-previous.ts <pr-number> <out.json>");
    console.error("env: GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY");
    process.exit(2);
}

/** A previous finding, cut down to what this run matches against. */
interface Previous {
    file: string;
    line?: number;
    title: string;
    status?: string;
    existing_comment_url?: string;
}

interface Artifact {
    id: number;
    name: string;
    expired: boolean;
    created_at: string;
    size_in_bytes: number;
    workflow_run?: { id: number; head_branch: string };
}

async function api(path: string): Promise<unknown> {
    const response = await fetch(`https://api.github.com${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} on ${path}: ${(await response.text()).slice(0, 200)}`);
    }

    return response.json();
}

/** The newest unexpired artifact of this pull request's branch. Throws when there is none. */
async function newestArtifact(): Promise<Artifact> {
    // The branch, rather than a run's `pull_requests` field, which GitHub leaves empty
    // often enough that matching on it would drop the previous run without saying so.
    const pull = (await api(`/repos/${repo}/pulls/${prNumber}`)) as { head?: { ref?: string } };
    const head = pull.head?.ref;

    if (!head) throw new Error("the pull request names no head branch");

    const current = Number(process.env.GITHUB_RUN_ID);

    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const listed = (await api(
            `/repos/${repo}/actions/artifacts?name=${ARTIFACT}&per_page=${PER_PAGE}&page=${page}`,
        )) as { artifacts?: Artifact[] };

        const batch = listed.artifacts ?? [];

        const candidate = [...batch]
            .filter((a) => !a.expired && a.workflow_run?.head_branch === head)
            // A re-run keeps the same run id, so this run's own earlier upload is listed
            // under it, and reading our own output back would mark every finding as
            // already reported.
            .filter((a) => !Number.isFinite(current) || a.workflow_run?.id !== current)
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

        if (candidate) return candidate;
        if (batch.length < PER_PAGE) break;
    }

    throw new Error(`no unexpired '${ARTIFACT}' artifact for ${head}`);
}

/** The artifact's zip, fetched without the token on the redirect that serves it. */
async function download(id: number): Promise<Uint8Array> {
    // The API answers with a redirect to storage, which authenticates through the signed
    // URL itself and rejects a request that also carries a bearer token. Following it by
    // hand is what keeps the two apart.
    const redirect = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
        headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
        redirect: "manual",
    });

    const location = redirect.headers.get("location");
    const response = location ? await fetch(location) : redirect;

    if (!response.ok) throw new Error(`HTTP ${response.status} downloading artifact ${id}`);

    return new Uint8Array(await response.arrayBuffer());
}

async function findingsOf(artifact: Artifact): Promise<Previous[]> {
    if (artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact ${artifact.id} is ${artifact.size_in_bytes} bytes, more than this reads`);
    }

    // The shipped workflow uploads the file itself and this repository's own workflow
    // uploads the whole build directory, so the entry sits either at the root of the
    // archive or one level inside it.
    const found = readFromZip(
        await download(artifact.id),
        (name) => name === "findings.json" || name.endsWith("/findings.json"),
    );

    if (!found) throw new Error(`artifact ${artifact.id} holds no findings.json`);

    const merged = JSON.parse(new TextDecoder().decode(found)) as { findings?: Previous[] };

    if (!Array.isArray(merged.findings)) {
        throw new Error(`artifact ${artifact.id} holds a findings.json with no findings array`);
    }

    // The file the orchestrator reads carries what it matches on and nothing else. A
    // previous body is a paragraph per finding, rewritten every run, so it is worth nothing
    // for matching and would put the whole of the last review into this one's context.
    return merged.findings
        .filter((f): f is Previous => typeof f?.file === "string" && typeof f?.title === "string")
        .map((f) => ({
            file: f.file,
            ...(Number.isInteger(f.line) ? { line: f.line } : {}),
            title: f.title,
            status: f.status ?? "new",
            ...(f.existing_comment_url ? { existing_comment_url: f.existing_comment_url } : {}),
        }));
}

let from: Artifact | null = null;
let findings: Previous[] = [];

try {
    from = await newestArtifact();
    findings = await findingsOf(from);
} catch (error) {
    // Every one of these means the same thing downstream: nothing to match against. The
    // usual is a 403, from a workflow that grants no `actions: read`.
    from = null;
    console.error(`previous findings: ${error instanceof Error ? error.message : String(error)}`);
}

await Bun.write(
    outPath,
    `${JSON.stringify(
        { ...(from ? { run: from.workflow_run?.id, taken: from.created_at } : {}), findings },
        null,
        2,
    )}\n`,
);

console.log(
    from
        ? `previous findings: ${findings.length} from run ${from.workflow_run?.id} (${from.created_at})`
        : "previous findings: none, so every finding counts as new",
);

export {};
