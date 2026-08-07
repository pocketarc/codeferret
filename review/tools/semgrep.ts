#!/usr/bin/env bun
/**
 * Run semgrep over the files this review's diff touches, and write down what it said.
 *
 * Nothing here judges whether a finding is real. That is the `static-analysis` lens's
 * job, and its own prompt in lenses/skills/static-analysis/SKILL.md carries the argument
 * for why tool output goes to a lens rather than straight to a reader.
 *
 * An installed semgrep is used if there is one, and a pinned container if there is not,
 * so nobody has to put Python on a machine to review a diff. The container costs a 420MB
 * pull the first time and nothing after. With neither available, this script records that
 * in its report and exits 0, because a review that stops for want of a linter is worth
 * less than one that runs without it.
 *
 * The image is pinned; the ruleset is not. `p/default` is fetched from semgrep's
 * registry on each run, so what the tool looks for can change between two runs of the
 * same commit. That is accepted here because a semgrep rule is declarative YAML rather
 * than code the job executes. `SEMGREP_CONFIG` names a ruleset inside the repository for
 * anyone who would rather pin it.
 *
 * Usage: bun review/tools/semgrep.ts <build-dir> <workspace>
 */

import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { argvBatches, keepRaised, MAX_FINDINGS, repoRoot, reporter, reportPath, startTool } from "./report.ts";

// One entry per file semgrep could only partly parse, so a diff in a language its parser
// struggles with writes a longer list than the capped findings beside it, into a file the
// lens is told to read in full.
const MAX_ERRORS = 50;

// `-nonroot` so a bind mount does not come back owned by root.
const IMAGE =
    "semgrep/semgrep:1.172.0-nonroot@sha256:d1012a3bf2acf47721216fbf7ff12d4c2971cc7f9c7b77cf6c6e9dcf006bd487";

// ERROR first, so the cap below takes the low end. Semgrep emits in scan order, which
// would let a hundred INFO hits in the first files push every ERROR out of the report.
const SEVERITY_ORDER = ["ERROR", "WARNING", "INFO"];

/** The part of semgrep's JSON this reads. */
interface SemgrepResult {
    check_id?: string;
    path?: string;
    start?: { line?: number };
    end?: { line?: number };
    extra?: { severity?: string; message?: string };
}

interface SemgrepOutput {
    results?: SemgrepResult[];
    errors?: Array<{ path?: string; message?: string }>;
    paths?: { scanned?: unknown[]; skipped?: unknown[] };
}

/** A file semgrep could only partly read, or a batch that produced nothing. */
interface ScanError {
    path?: string;
    message: string;
}

function severityRank(value: unknown): number {
    const i = SEVERITY_ORDER.indexOf(String(value ?? "").toUpperCase());
    return i === -1 ? SEVERITY_ORDER.length : i;
}

const [buildDir, workspace] = process.argv.slice(2);

if (!buildDir || !workspace) {
    console.error("usage: bun review/tools/semgrep.ts <build-dir> <workspace>");
    process.exit(2);
}

// `handed` is how many files were passed over, against `scanned`, which is how many
// semgrep says it analysed. It filters its target set before scanning, and one filter is a
// `.semgrepignore` that whoever opened the change may have written.
const extras: {
    handed: number;
    skipped: number;
    batches: number;
    unreadable: number;
    errors: ScanError[];
    errors_truncated: number;
} = { handed: 0, skipped: 0, batches: 0, unreadable: 0, errors: [], errors_truncated: 0 };

// Every git and semgrep call below is given the repository root, because that is what git
// prints paths relative to and what a finding has to anchor against. This process's own
// working directory is somewhere else, for the reason `repoRoot` gives.
const root = repoRoot(workspace);
const write = reporter("semgrep", reportPath("semgrep", buildDir), extras);

const started = await startTool({
    tool: "semgrep",
    image: IMAGE,
    command: "semgrep",
    buildDir,
    root,
    usePathspec: true,
    write,
});

if (!started) process.exit(0);

const files = started.changed.present;

if (started.changed.named.length > 0 && files.length === 0) {
    await write({
        ran: false,
        reason: `git named ${started.changed.named.length} changed file(s) and none of them exist under ${root}`,
    });
    console.error("semgrep: none of the changed files are readable, skipped");
    process.exit(0);
}

if (files.length === 0) {
    await write({ ran: true, how: started.how, scanned: 0 });
    console.log("semgrep: the diff touches no readable file");
    process.exit(0);
}

/** What the tool scans under when `SEMGREP_CONFIG` names nothing. */
const DEFAULT_RULESET = "p/default";

/**
 * One entry of `SEMGREP_CONFIG`, resolved.
 *
 * A ruleset on disk has to sit inside the repository. On the container path semgrep sees
 * the repository at /src and nothing else, so an absolute host path resolves to nothing
 * there, and a relative one works only because the container's working directory is the
 * repository root. Anything that is not a path on disk is a registry identifier and goes
 * through as written.
 */
function entry(configured: string): { config: string; local: boolean } | { refusal: string } {
    const resolved = resolve(root, configured);

    if (!existsSync(resolved)) return { config: configured, local: false };

    return resolved.startsWith(`${root}/`)
        ? { config: relative(root, resolved), local: true }
        : {
              refusal:
                  `SEMGREP_CONFIG is '${configured}', which resolves outside the repository.` +
                  " semgrep sees only the repository, so name a ruleset inside it.",
          };
}

/**
 * Every ruleset to scan under.
 *
 * `SEMGREP_CONFIG` is read as a list, separated by commas or whitespace. The rules most worth
 * having here are not in `p/default`: the taint-tracking SQL and injection rules live in packs
 * of their own, and semgrep takes `--config` once per ruleset rather than as one
 * comma-separated value. Read as a single value, naming one of those packs dropped the
 * defaults and everything in them, and no setting got both. `p/default p/sql-injection` now
 * does.
 *
 * The list is the whole of what runs. `p/default` is where an unset variable lands, not a
 * floor under a list that names something else, because a maintainer setting this to a file
 * in the repository is closing the registry fetch, and adding the defaults back would reopen
 * it.
 */
function ruleset(): { configs: string[]; remote: string[] } | { refusal: string } {
    const configured = (process.env.SEMGREP_CONFIG ?? "").split(/[,\s]+/).filter((value) => value !== "");
    const wanted = configured.length > 0 ? configured : [DEFAULT_RULESET];

    const configs: string[] = [];
    const remote: string[] = [];

    for (const value of wanted) {
        const resolved = entry(value);

        if ("refusal" in resolved) return resolved;

        configs.push(resolved.config);
        if (!resolved.local) remote.push(resolved.config);
    }

    return { configs, remote };
}

const chosen = ruleset();

if ("refusal" in chosen) {
    await write({ ran: false, reason: chosen.refusal });
    console.error(`semgrep: ${chosen.refusal}`);
    process.exit(0);
}

const results: SemgrepResult[] = [];
const allErrors: ScanError[] = [];
let analysed = 0;
let skipped = 0;

const chunks = argvBatches(files);

for (const chunk of chunks) {
    const proc = Bun.spawnSync(
        [
            ...started.argv,
            ...chosen.configs.flatMap((config) => ["--config", config]),
            "--json",
            "--quiet",
            "--metrics",
            "off",
            // Every path here is one whoever opened the change chose, and a filename is
            // allowed to start with a dash. Without `--`, a file called
            // `--config=https://...` is a second ruleset and `--autofix` is a linter rewriting
            // the tree every lens is reading.
            "--",
            ...chunk,
        ],
        { cwd: root },
    );

    let parsed: SemgrepOutput;

    try {
        parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as SemgrepOutput;
    } catch {
        const stderr = new TextDecoder().decode(proc.stderr).slice(0, 300);
        allErrors.push({
            message: `a batch of ${chunk.length} file(s) returned no JSON (exit ${proc.exitCode}): ${stderr}`,
        });
        continue;
    }

    results.push(...(parsed.results ?? []));

    // Semgrep parses what it can and skips the rest of a construct it cannot read, so a
    // file in this list got less than a full scan. A count alone would leave the lens
    // asserting coverage of files nothing read, so each one carries its path and the
    // reason.
    for (const error of parsed.errors ?? []) {
        allErrors.push({ path: error.path, message: String(error.message ?? "").slice(0, 300) });
    }

    // Semgrep's own account of its target set, not the length of the argument list.
    analysed += Array.isArray(parsed.paths?.scanned) ? parsed.paths.scanned.length : chunk.length;
    skipped += Array.isArray(parsed.paths?.skipped) ? parsed.paths.skipped.length : 0;
}

if (results.length === 0 && allErrors.length > 0 && analysed === 0) {
    await write({
        ran: false,
        how: started.how,
        reason: `no batch produced output: ${allErrors.map((e) => e.message).join("; ").slice(0, 500)}`,
        handed: files.length,
        batches: chunks.length,
        errors: allErrors.slice(0, MAX_ERRORS),
        errors_truncated: Math.max(0, allErrors.length - MAX_ERRORS),
    });
    console.error("semgrep: nothing could be scanned, skipped");
    process.exit(0);
}

results.sort((a, b) => severityRank(a.extra?.severity) - severityRank(b.extra?.severity));

const errors = allErrors.slice(0, MAX_ERRORS);

// The image is pinned by digest but the shape it emits is upstream's, and a renamed field
// hands the lens a hundred findings with every field empty while the report still carries
// the right count. Both of these are always present in 1.172.0's output, so an absence
// means the shape has moved, and this is what makes that visible to the lens.
const unreadable = results.filter((r) => !r.check_id || !r.path).length;

const raised = results.map((r) => ({
    rule: r.check_id,
    file: r.path,
    line: r.start?.line,
    end_line: r.end?.line,
    severity: r.extra?.severity,
    message: r.extra?.message,
}));

const findings = raised.slice(0, MAX_FINDINGS);

await keepRaised("semgrep", buildDir, raised);

await write({
    ran: true,
    how: started.how,
    handed: files.length,
    batches: chunks.length,
    scanned: analysed,
    skipped,
    raised: results.length,
    truncated: Math.max(0, results.length - findings.length),
    unreadable,
    errors,
    errors_truncated: allErrors.length - errors.length,
    // A ruleset on disk is read from the bind mount, so it is left out of this line: what a
    // maintainer wants from it is what left the runner. With every entry local, nothing did.
    egress:
        chosen.remote.length === 0
            ? null
            : `fetched its ${chosen.remote.map((config) => `\`${config}\``).join(" and ")}` +
              ` ruleset${chosen.remote.length === 1 ? "" : "s"} from semgrep's registry`,
    findings,
});

console.log(
    `semgrep: ${results.length} raised over ${analysed} of ${files.length} file(s)` +
        `${chunks.length > 1 ? ` in ${chunks.length} batches` : ""}` +
        `${results.length > findings.length ? `, ${results.length - findings.length} beyond the cap` : ""}` +
        `${allErrors.length > 0 ? `, ${allErrors.length} file(s) only partly read` : ""}` +
        `${unreadable > 0 ? `, ${unreadable} with no rule or path` : ""}`,
);
