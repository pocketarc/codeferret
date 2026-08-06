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
 * Reading an artifact needs `actions: read`, which the shipped workflow grants and a
 * consumer can decline. So every failure here is a line on stderr and a file holding no
 * findings, and the orchestrator reads that the same way it reads a first run: every
 * finding is new.
 *
 * Four things have to be true of an artifact before what it holds silences anything: its
 * review was posted, the review was of this pull request, it came from a run of a branch
 * pushed here, and that run was one of this workflow's. `previous.ts` answers each of them,
 * on the function that makes it, and "The previous run's findings come out of its artifact"
 * in `review/README.md` has the argument for all four.
 *
 * Usage: bun fetch-previous.ts <pr-number> <out.json>
 * Env:   GITHUB_TOKEN (or the token on stdin), GITHUB_REPOSITORY, GITHUB_RUN_ID
 */

import { requirePullNumber, requireRepository, rest, restJson, tokenFromStdinOrEnv } from "./github.ts";
import { reason, record } from "./json.ts";
import { candidates, firstPosted, sameWorkflow } from "./previous.ts";
import type { Artifact, Previous } from "./previous.ts";
import { MAX_ENTRY_BYTES, readFromZip } from "./unzip.ts";

/** The name the shipped workflow gives the upload. A repository that renames it opts out. */
const ARTIFACT = "codeferret-run";

/** Artifacts are listed newest first, so this is how far back a busy repository is searched. */
const MAX_PAGES = 5;
const PER_PAGE = 100;

/**
 * What action.yml keeps an artifact for. Nothing older is still downloadable.
 *
 * validate-repo.ts checks the two against each other, because raising one without the
 * other stops this paging at an artifact that is still there.
 */
const RETENTION_DAYS = 14;

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

requireRepository(repo);

const pull: string = requirePullNumber(prNumber);

const MAX_REDIRECTS = 5;

/**
 * The redirect target, refused unless it is one this will fetch.
 *
 * Bun's fetch honours `file:`, so a `Location` naming one would have this read a local path
 * and hand the bytes on as an artifact. The value comes from api.github.com today, and it
 * is the one input this file takes on faith.
 */
function storageUrl(location: string): string {
    const parsed = new URL(location);

    if (parsed.protocol !== "https:") {
        throw new Error(`the artifact redirect points at ${parsed.protocol}, which this will not fetch`);
    }

    return parsed.href;
}

/**
 * Follow the chain by hand, checking every hop rather than only the first.
 *
 * The API answers with a redirect to storage, which authenticates through the signed URL
 * itself and rejects a request that also carries a bearer token. Following it by hand is
 * what keeps the two apart, and it is also what puts every `Location` through the check
 * above: a guard that stops at hop one reads as covering a chain it does not bound.
 */
async function followRedirects(response: Response): Promise<Response> {
    let current = response;

    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
        const location = current.headers.get("location");

        // The status decides, not the header: `Location` is legal on a response that is not
        // a redirect, and following one of those would throw the artifact away.
        if (current.status < 300 || current.status >= 400 || !location) return current;

        current = await fetch(storageUrl(location), { redirect: "manual" });
    }

    throw new Error(`the artifact download did not settle in ${MAX_REDIRECTS} redirects`);
}

/**
 * The artifact's zip, refused past the size this reads rather than buffered whole.
 *
 * `size_in_bytes` describes the archive GitHub recorded when the upload finished, not the
 * bytes that arrive now, so the running total is the only figure worth checking.
 */
async function download(id: number): Promise<Uint8Array> {
    const response = await followRedirects(
        await rest(token, `/repos/${repo}/actions/artifacts/${id}/zip`, { redirect: "manual" }),
    );

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

/**
 * The workflow this run belongs to, or null where nothing names one.
 *
 * Null is `/codeferret:review` on somebody's own machine, and `sameWorkflow` then accepts
 * any run, because what a session does with a previous artifact is print it to the person
 * who asked.
 *
 * A run id that is set and cannot be resolved is a different thing, and it throws. Answering
 * null there would let one transient API error open the single path a forged artifact walks
 * through, and that check exists because nothing on that path leaves a trace anywhere a
 * reviewer looks. The throw costs one review that repeats itself, which is what every other
 * refusal in this file costs.
 */
async function ownWorkflow(): Promise<number | null> {
    const id = process.env.GITHUB_RUN_ID;

    if (!id || !/^[0-9]+$/.test(id)) return null;

    const run = record(await restJson(token, `/repos/${repo}/actions/runs/${id}`));
    const workflow = run?.workflow_id;

    if (typeof workflow !== "number" || !Number.isInteger(workflow)) {
        throw new Error(`run ${id} names no workflow, so no artifact can be checked against it`);
    }

    return workflow;
}

let own: number | null = null;

/** One artifact's findings.json, parsed. */
async function openArtifact(artifact: Artifact): Promise<unknown> {
    if (artifact.size_in_bytes > MAX_ARTIFACT_BYTES) {
        throw new Error(`artifact ${artifact.id} is ${artifact.size_in_bytes} bytes, more than this reads`);
    }

    // Before the download, because a run of another workflow has nothing to say here
    // however its findings file reads.
    const producer = artifact.workflow_run?.id;

    if (own !== null) {
        // Said here rather than left to the request. Interpolated undefined asks GitHub for
        // `/runs/undefined`, and the 404 that comes back reads as a run that is not there
        // when the truth is that the listing named none.
        if (!Number.isInteger(producer)) {
            throw new Error(`artifact ${artifact.id} names no producing run`);
        }

        const producingRun = await restJson(token, `/repos/${repo}/actions/runs/${producer}`);

        if (!sameWorkflow(own, producingRun)) {
            throw new Error(`artifact ${artifact.id} came from run ${producer}, which is not this workflow`);
        }
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

    return JSON.parse(new TextDecoder().decode(found));
}

/**
 * The artifacts of this pull request's branch, newest first.
 *
 * The endpoint lists every CodeFerret artifact in the repository, so on a busy repository
 * the branch's own can sit several pages down. Paging stops at the retention window, past
 * which nothing is still downloadable, and a line on stderr names the page cap when that is
 * what ended the search: running out without a word leaves a review that repeats itself
 * and no sign of the reason.
 */
async function branchArtifacts(head: string): Promise<Artifact[]> {
    const current = Number(process.env.GITHUB_RUN_ID);
    const oldest = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const found: Artifact[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const listed = (await restJson(
            token,
            `/repos/${repo}/actions/artifacts?name=${ARTIFACT}&per_page=${PER_PAGE}&page=${page}`,
        )) as { artifacts?: Artifact[] };

        const batch = listed.artifacts ?? [];

        found.push(...candidates(batch, head, current));

        if (batch.length < PER_PAGE) return found;

        const last = batch[batch.length - 1];
        if (last && Date.parse(last.created_at) < oldest) return found;

        if (page === MAX_PAGES) {
            console.error(
                `previous findings: stopped after ${MAX_PAGES * PER_PAGE} artifacts, which is this search's limit` +
                    " rather than the end of the list",
            );
        }
    }

    return found;
}

/** The newest artifact of this branch whose review was posted, and what it reported. */
async function previousRun(): Promise<{ from: Artifact; findings: Previous[] } | null> {
    // The branch, rather than a run's `pull_requests` field, which GitHub leaves empty
    // often enough that matching on it would drop the previous run without saying so. The
    // pull request number is then checked inside the artifact, where post-review.ts wrote it.
    const request = (await restJson(token, `/repos/${repo}/pulls/${pull}`)) as { head?: { ref?: string } };
    const head = request.head?.ref;

    if (!head) throw new Error("the pull request names no head branch");

    return firstPosted(await branchArtifacts(head), pull, openArtifact, MAX_CANDIDATES, (line) =>
        console.error(line),
    );
}

let from: Artifact | null = null;
let findings: Previous[] = [];

try {
    own = await ownWorkflow();

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
