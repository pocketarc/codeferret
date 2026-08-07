/**
 * Which artifact the previous review is in, and what it holds.
 *
 * Every decision here answers whether something already raised may silence a finding this
 * run made, and a wrong answer marks that finding `already-reported` in this run's own
 * findings file, so the suppression lasts as long as the pull request. None of it is
 * visible in the review, which is why it sits apart from fetch-previous.ts, where a test
 * can reach it.
 */

import type { Finding } from "./findings.ts";
import { reason, record } from "./json.ts";

/**
 * A previous finding, cut down to what this run matches against.
 *
 * Taken from `Finding` rather than restated, because previous.json is matched against this
 * run's findings on `file` plus `title`, and `existing_comment_url` is copied from one into
 * the other. Renaming a field on either side would otherwise stop the match with nothing
 * saying so. `line` is optional here: a finding whose line is not an integer still matches.
 */
export type Previous = Pick<Finding, "file" | "title" | "status" | "existing_comment_url"> &
    Partial<Pick<Finding, "line">>;

/**
 * The files the previous review raised something in.
 *
 * The whole of what `vetSuppression` asks of previous.json, answered once where the file is
 * read rather than once per finding: the answer is the same for every finding in the run.
 * The same boundary `asExisting` gives existing.json, and for the same reason: without it, a
 * null, an array or a missing key comes back as `undefined` deep inside the vetting, and the
 * suppression it decides is wrong with nothing saying so.
 */
export function filesRaisedBefore(value: unknown): ReadonlySet<string> {
    const entries = record(value)?.findings;

    if (!Array.isArray(entries)) return new Set();

    return new Set(
        entries.flatMap((entry) => {
            const file = record(entry)?.file;

            return typeof file === "string" && file !== "" ? [file] : [];
        }),
    );
}

export interface WorkflowRun {
    id?: number;
    head_branch?: string;
    repository_id?: number;
    head_repository_id?: number;
}

export interface Artifact {
    id: number;
    name: string;
    expired: boolean;
    created_at: string;
    size_in_bytes: number;
    workflow_run?: WorkflowRun;
}

const STATUSES = ["new", "already-reported", "declined"] as const;

/** A status the orchestrator can read back, with the schema's own default for the rest. */
function statusOf(value: unknown): Finding["status"] {
    return STATUSES.find((status) => status === value) ?? "new";
}

/**
 * Whether the run that uploaded this came from a branch pushed to this repository.
 *
 * A field GitHub stopped sending would fail this for every artifact, which costs a
 * repeated comment rather than a hidden finding. That is the direction to fail in.
 */
export function fromThisRepository(run: WorkflowRun | undefined): boolean {
    if (!run) return false;

    const { repository_id: base, head_repository_id: head } = run;

    return Number.isInteger(base) && Number.isInteger(head) && base === head;
}

/**
 * Whether the run that uploaded this belongs to the workflow now running.
 *
 * The name `codeferret-run` is protocol between the step that writes an artifact and the run
 * that reads it, and the artifacts endpoint lists every artifact of that name in the
 * repository whatever produced it. Without this, anyone who can push a branch can add a
 * throwaway workflow that uploads a `findings.json` carrying a `posted` record and a list of
 * file and title pairs, let it run once, and delete it again: the artifact outlives the
 * branch, the endpoint lists it ahead of every genuine one, and the next review marks each
 * of those findings `already-reported`. Editing `fetch-previous.ts` would do the same thing
 * and be in the diff at merge time; this leaves no trace anywhere a reviewer looks.
 *
 * `own` is null where nothing names a workflow, which is `/codeferret:review` on somebody's
 * own machine, and then any run counts. What a session does with a previous artifact is
 * print it to the person who asked, and they can see what they were shown.
 */
export function sameWorkflow(own: number | null, producingRun: unknown): boolean {
    if (own === null) return true;

    const id = record(producingRun)?.workflow_id;

    return Number.isInteger(id) && id === own;
}

/**
 * When post-review.ts recorded this pull request's review as accepted, or null.
 *
 * The pull request number has to match. Artifacts are found by head branch, and a branch
 * name is reused within the retention window as soon as a merged branch is recreated, and
 * one branch can head two open pull requests at once. On the branch alone, one pull
 * request's review silences findings on another's.
 *
 * A record carrying no number comes from a version that wrote none, and it does not match:
 * that costs one round of repeated comments, which is what every other refusal here costs.
 */
export function postedFor(marker: unknown, pull: string): string | null {
    const posted = record(marker);
    const at = posted?.at;

    if (typeof at !== "string" || at.trim() === "") return null;

    return String(posted?.pr) === pull ? at : null;
}

/**
 * The artifacts of this branch worth opening, newest first.
 *
 * A re-run keeps the same run id, so this run's own earlier upload is listed under it, and
 * reading our own output back would mark every finding as already reported.
 */
export function candidates(batch: Artifact[], head: string, currentRunId: number): Artifact[] {
    return batch
        .filter((a) => !a.expired && a.workflow_run?.head_branch === head)
        .filter((a) => !Number.isFinite(currentRunId) || a.workflow_run?.id !== currentRunId)
        .filter((a) => fromThisRepository(a.workflow_run))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/**
 * What one artifact's findings.json reported, or null when it records no review of this
 * pull request.
 *
 * The bodies are left behind. Matching is on the file and the title, a previous body is a
 * paragraph per finding rewritten every run, and carrying the whole of the last review into
 * this one's context buys nothing.
 */
export function previousOf(parsed: unknown, pull: string, label: string): Previous[] | null {
    const merged = record(parsed);

    if (!merged || !Array.isArray(merged.findings)) {
        throw new Error(`${label} holds a findings.json with no findings array`);
    }

    if (!postedFor(merged.posted, pull)) return null;

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
            status: statusOf(finding.status),
            ...(typeof url === "string" && url ? { existing_comment_url: url } : {}),
        });
    }

    return previous;
}

/**
 * The newest artifact whose review reached this pull request, and what it reported.
 *
 * A run whose review never landed left nothing on the pull request, so the run before it is
 * still the last word and the walk steps over it. `open` is a parameter because it is the
 * one expensive decision here, a download apiece, and a test has to stand in for it.
 * `MAX_CANDIDATES` in fetch-previous.ts has why the caller's `limit` is where it is.
 */
export async function firstPosted(
    list: Artifact[],
    pull: string,
    open: (artifact: Artifact) => Promise<unknown>,
    limit: number,
    say: (line: string) => void,
): Promise<{ from: Artifact; findings: Previous[] } | null> {
    let opened = 0;

    for (const artifact of list) {
        if (opened >= limit) break;

        opened += 1;

        try {
            const findings = previousOf(await open(artifact), pull, `artifact ${artifact.id}`);

            if (findings) return { from: artifact, findings };

            say(
                `previous findings: artifact ${artifact.id} records no posted review of #${pull},` +
                    " so what it holds counts as unsaid",
            );
        } catch (error) {
            say(`previous findings: artifact ${artifact.id}: ${reason(error)}`);
        }
    }

    // After the loop, not on the iteration that would have exceeded the limit: with exactly
    // `limit` candidates and none posted, the loop runs out, and the caller then
    // reports "no posted artifact for this branch", which means there were none. Stopping at
    // the search's own limit is a different fact, and the one that explains a review
    // repeating itself.
    if (opened >= limit) {
        say(`previous findings: gave up after opening ${opened} artifacts, none of them posted`);
    }

    return null;
}
