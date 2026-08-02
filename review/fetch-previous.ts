#!/usr/bin/env bun
/**
 * Fetch the findings the previous run left behind, so this run can tell a finding it has
 * already reported from one nobody has seen.
 *
 * Every push re-runs the whole review. A review is one body now, and a review body is
 * neither a review thread nor a conversation comment, so nothing fetch-existing.ts reads
 * carries what the last run said: without this, every finding is raised again on every
 * push for ever. The run's own findings file is the record instead, and the action's last
 * step keeps it as the `codeferret-run` artifact.
 *
 * Reading an artifact needs `actions: read`. The shipped workflow grants it, but a
 * consumer can decline it and a review must survive that, so every failure here is a line
 * on stderr and a file holding no findings. No permission, no artifact, a retention window
 * that has closed, and a first run all mean the same thing to the orchestrator: every
 * finding is new. That is what happened before this script existed, so nothing is worse
 * off for its absence.
 *
 * An artifact has to prove two things before what it holds silences anything.
 *
 * Its review has to have been posted. post-review.ts writes `posted` into findings.json
 * once GitHub has accepted the review, and the action uploads after that, so the record
 * travels inside the one file every consumer keeps. Four ordinary paths reach an uploaded
 * artifact with no review on the pull request at all: `post: 'false'`, a 502 from the
 * reviews endpoint, a token without `pull-requests: write`, and a run that
 * `cancel-in-progress` kills while the upload step still runs `if: always()`. A run that
 * believes one of those marks every finding `already-reported` against comments nobody
 * ever saw, and writes that status into its own findings file, so the suppression lasts as
 * long as the pull request. A run that ends red is a different thing and still counts:
 * check-findings.ts drops what it cannot use, the review lands, and the job goes red over
 * what was dropped.
 *
 * It has to have come from a run of a branch pushed here. For a `pull_request` event GitHub
 * runs the workflow files as the pull request has them, so a fork's copy of the workflow
 * runs, and whatever it uploads is stored against this repository and listed here.
 * `head_branch` is a name whoever opened the pull request chose, so matching on it is no
 * evidence at all. The two repository ids on the producing run differ for every fork run
 * and match for every run of a branch pushed here. What that leaves is anyone with push
 * access, who can change this file instead.
 *
 * Usage: bun fetch-previous.ts <pr-number> <out.json>
 * Env:   GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY, GITHUB_RUN_ID
 */

import { rest, restJson, splitRepository, tokenFromStdinOrEnv } from "./github.ts";
import { MAX_ENTRY_BYTES, readFromZip } from "./unzip.ts";

/** The name the shipped workflow gives the upload. A repository that renames it opts out. */
const ARTIFACT = "codeferret-run";

/** Artifacts are listed newest first, so this is how far back a busy repository is searched. */
const MAX_PAGES = 5;
const PER_PAGE = 100;

/**
 * How many artifacts are opened before this gives up.
 *
 * Each one is a download, and every artifact predating the `posted` record fails the check,
 * so the run this lands in walks every artifact its pull request has. Ten back is far
 * enough to step over a cancelled run or two; past that, nothing has posted in a long while
 * and treating every finding as new is the right answer anyway.
 */
const MAX_CANDIDATES = 10;

/** Big enough for a whole build directory, small enough that a runner cannot be made to fetch a disk. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const [prNumber, outPath] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const token = await tokenFromStdinOrEnv();

if (!prNumber || !outPath || !token || !repo) {
    console.error("usage: bun fetch-previous.ts <pr-number> <out.json>");
    console.error("env: GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY");
    process.exit(2);
}

if (!splitRepository(repo)) {
    console.error(`GITHUB_REPOSITORY is '${repo}'. It has to be owner/name.`);
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

interface WorkflowRun {
    id?: number;
    head_branch?: string;
    repository_id?: number;
    head_repository_id?: number;
}

interface Artifact {
    id: number;
    name: string;
    expired: boolean;
    created_at: string;
    size_in_bytes: number;
    workflow_run?: WorkflowRun;
}

function record(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the run that uploaded this came from a branch pushed to this repository.
 *
 * A field GitHub stopped sending would fail this for every artifact, which costs a
 * repeated comment rather than a hidden finding. That is the direction to fail in.
 */
function fromThisRepository(run: WorkflowRun | undefined): boolean {
    if (!run) return false;

    const { repository_id: base, head_repository_id: head } = run;

    return Number.isInteger(base) && Number.isInteger(head) && base === head;
}

/** When post-review.ts recorded the review as accepted, or null when nothing did. */
function postedAt(marker: unknown): string | null {
    const at = record(marker)?.at;

    return typeof at === "string" && at.trim() !== "" ? at : null;
}

/**
 * The artifact's zip, refused past the size this reads rather than buffered whole.
 *
 * `size_in_bytes` describes the archive GitHub recorded when the upload finished, not the
 * bytes that arrive now, so the running total is the only figure worth checking.
 */
async function download(id: number): Promise<Uint8Array> {
    // The API answers with a redirect to storage, which authenticates through the signed
    // URL itself and rejects a request that also carries a bearer token. Following it by
    // hand is what keeps the two apart.
    const redirect = await rest(token, `/repos/${repo}/actions/artifacts/${id}/zip`, {
        redirect: "manual",
    });

    const location = redirect.headers.get("location");
    const response = location ? await fetch(location) : redirect;

    if (!response.ok) throw new Error(`HTTP ${response.status} downloading artifact ${id}`);

    const reader = response.body?.getReader();

    if (!reader) throw new Error(`artifact ${id} came back with no body`);

    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        total += value.length;

        if (total > MAX_ARTIFACT_BYTES) {
            await reader.cancel();
            throw new Error(`artifact ${id} is longer than the ${MAX_ARTIFACT_BYTES} bytes this reads`);
        }

        chunks.push(value);
    }

    const zip = new Uint8Array(total);
    let at = 0;

    for (const chunk of chunks) {
        zip.set(chunk, at);
        at += chunk.length;
    }

    return zip;
}

/** What an artifact reported, or null when it records no posted review. */
async function findingsOf(artifact: Artifact): Promise<Previous[] | null> {
    if (artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact ${artifact.id} is ${artifact.size_in_bytes} bytes, more than this reads`);
    }

    // The shipped workflow uploads the file itself and this repository's own workflow
    // uploads the whole build directory, so the entry sits either at the root of the
    // archive or one level inside it.
    const found = readFromZip(
        await download(artifact.id),
        (name) => name === "findings.json" || name.endsWith("/findings.json"),
        MAX_ENTRY_BYTES,
    );

    if (!found) throw new Error(`artifact ${artifact.id} holds no findings.json`);

    const merged = record(JSON.parse(new TextDecoder().decode(found)));

    if (!merged || !Array.isArray(merged.findings)) {
        throw new Error(`artifact ${artifact.id} holds a findings.json with no findings array`);
    }

    if (!postedAt(merged.posted)) return null;

    // The file the orchestrator reads carries what it matches on and nothing else. A
    // previous body is a paragraph per finding, rewritten every run, so it is worth nothing
    // for matching and would put the whole of the last review into this one's context.
    const previous: Previous[] = [];

    for (const entry of merged.findings) {
        const finding = record(entry);

        if (!finding || typeof finding.file !== "string" || typeof finding.title !== "string") continue;

        const line = finding.line;
        const url = finding.existing_comment_url;

        previous.push({
            file: finding.file,
            ...(typeof line === "number" && Number.isInteger(line) ? { line } : {}),
            title: finding.title,
            status: typeof finding.status === "string" ? finding.status : "new",
            ...(typeof url === "string" && url ? { existing_comment_url: url } : {}),
        });
    }

    return previous;
}

/** The newest artifact of this branch whose review was posted, and what it reported. */
async function previousRun(): Promise<{ from: Artifact; findings: Previous[] } | null> {
    // The branch, rather than a run's `pull_requests` field, which GitHub leaves empty
    // often enough that matching on it would drop the previous run without saying so.
    const pull = (await restJson(token, `/repos/${repo}/pulls/${prNumber}`)) as { head?: { ref?: string } };
    const head = pull.head?.ref;

    if (!head) throw new Error("the pull request names no head branch");

    const current = Number(process.env.GITHUB_RUN_ID);
    let opened = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const listed = (await restJson(
            token,
            `/repos/${repo}/actions/artifacts?name=${ARTIFACT}&per_page=${PER_PAGE}&page=${page}`,
        )) as { artifacts?: Artifact[] };

        const batch = listed.artifacts ?? [];

        const candidates = batch
            .filter((a) => !a.expired && a.workflow_run?.head_branch === head)
            // A re-run keeps the same run id, so this run's own earlier upload is listed
            // under it, and reading our own output back would mark every finding as
            // already reported.
            .filter((a) => !Number.isFinite(current) || a.workflow_run?.id !== current)
            .filter((a) => fromThisRepository(a.workflow_run))
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

        // A run whose review never landed said nothing, so the run before it is still the
        // last word on this pull request.
        for (const artifact of candidates) {
            if (opened >= MAX_CANDIDATES) {
                console.error(`previous findings: gave up after opening ${opened} artifacts, none of them posted`);
                return null;
            }

            opened += 1;

            try {
                const findings = await findingsOf(artifact);

                if (findings) return { from: artifact, findings };

                console.error(
                    `previous findings: artifact ${artifact.id} records no posted review, so what it holds counts as unsaid`,
                );
            } catch (error) {
                console.error(`previous findings: artifact ${artifact.id}: ${reason(error)}`);
            }
        }

        if (batch.length < PER_PAGE) break;
    }

    return null;
}

let from: Artifact | null = null;
let findings: Previous[] = [];

try {
    const previous = await previousRun();

    if (previous) {
        from = previous.from;
        findings = previous.findings;
    } else {
        console.error(`previous findings: no posted '${ARTIFACT}' artifact for this branch`);
    }
} catch (error) {
    // Every one of these means the same thing downstream: nothing to match against. The
    // usual is a 403, from a workflow that grants no `actions: read`.
    console.error(`previous findings: ${reason(error)}`);
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
