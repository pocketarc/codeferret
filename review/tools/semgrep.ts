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
 * pull the first time and nothing after. Neither one available is written down and
 * skipped, because a review that stops for want of a linter is worth less than one that
 * runs without it.
 *
 * The image is pinned; the ruleset is not. `p/default` is fetched from semgrep's
 * registry on each run, so what the tool looks for can change between two runs of the
 * same commit. That is accepted here because a semgrep rule is declarative YAML rather
 * than code the job executes. `SEMGREP_CONFIG` names a ruleset inside the repository for
 * anyone who would rather pin it.
 *
 * Usage: bun review/tools/semgrep.ts <build-dir>
 */

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { repoRoot as findRepoRoot, reporter } from "./report";

// The lens reads every finding it is handed and checks it against the code, so a
// pathological run would make one lens the most expensive thing in the review.
const MAX_FINDINGS = 100;

// One entry per file semgrep could only partly parse, so a diff in a language its parser
// struggles with writes a longer list than the capped findings beside it, into a file the
// lens is told to read in full.
const MAX_ERRORS = 50;

// A review job holds a write token, so what it runs should not change between runs.
// `-nonroot` so a bind mount does not come back owned by root.
const IMAGE =
    "semgrep/semgrep:1.172.0-nonroot@sha256:d1012a3bf2acf47721216fbf7ff12d4c2971cc7f9c7b77cf6c6e9dcf006bd487";

// ERROR first, so the cap below takes the low end. Semgrep emits in scan order, which
// would let a hundred INFO hits in the first files push every ERROR out of the report.
const SEVERITY_ORDER = ["ERROR", "WARNING", "INFO"];

function severityRank(value: unknown): number {
    const i = SEVERITY_ORDER.indexOf(String(value ?? "").toUpperCase());
    return i === -1 ? SEVERITY_ORDER.length : i;
}

const [buildDir] = process.argv.slice(2);

if (!buildDir) {
    console.error("usage: bun review/tools/semgrep.ts <build-dir>");
    process.exit(2);
}

// Everything below runs from the repository root, because that is what git prints paths
// relative to and what a finding has to anchor against.
const repoRoot = findRepoRoot();

const write = reporter("semgrep", join(buildDir, "tool-semgrep.json"), {
    // How many files were handed over, against how many semgrep says it analysed. It
    // filters its target set before scanning, and one filter is a `.semgrepignore` that
    // whoever opened the change may have written.
    handed: 0,
    skipped: 0,
    errors: [],
    errors_truncated: 0,
});

function runner(): { argv: string[]; how: string } | null {
    if (Bun.which("semgrep")) return { argv: ["semgrep"], how: "binary" };

    if (Bun.which("docker")) {
        return {
            argv: [
                "docker",
                "run",
                "--rm",
                "--volume",
                `${repoRoot}:/src:ro`,
                "--workdir",
                "/src",
                IMAGE,
                "semgrep",
            ],
            how: `docker ${IMAGE}`,
        };
    }

    return null;
}

const semgrep = runner();

if (!semgrep) {
    await write({ ran: false, reason: "neither semgrep nor docker is on PATH" });
    console.log("semgrep: no semgrep and no docker, skipped");
    process.exit(0);
}

// The same arguments the lenses' own diff uses, so the tool and the review never
// disagree about which files are under review.
const argsFile = join(buildDir, "diff-args");

if (!existsSync(argsFile)) {
    await write({ ran: false, reason: `no ${argsFile}` });
    console.error(`semgrep: ${argsFile} is missing, skipped`);
    process.exit(0);
}

const diffArgs = (await Bun.file(argsFile).text()).split("\0").filter(Boolean);

// -d drops deleted files: semgrep cannot read what is no longer there. -z because git
// backslash-quotes any path outside ASCII unless it is asked not to, and a quoted path
// matches no file on disk, so those files would drop out of the scan without a word.
const named = Bun.spawnSync(["git", "diff", "--name-only", "-z", "--diff-filter=d", ...diffArgs], {
    cwd: repoRoot,
});

// A failing git diff writes nothing to stdout, which is the same shape as a diff touching
// no file, and the report would then say the tool scanned a clean zero.
if (named.exitCode !== 0) {
    const stderr = new TextDecoder().decode(named.stderr).trim().slice(0, 300);
    await write({ ran: false, reason: `git diff failed: ${stderr || `exit ${named.exitCode}`}` });
    console.error("semgrep: git diff failed, skipped");
    process.exit(0);
}

const namedPaths = new TextDecoder().decode(named.stdout).split("\0").filter(Boolean);

// Joined to the repository root, because that is what git printed them relative to.
// Unjoined, these resolve against the caller's directory and vanish the moment the caller
// is anywhere else, and an empty scan is indistinguishable from a clean one.
const files = namedPaths.filter((f) => existsSync(join(repoRoot, f)));

if (namedPaths.length > 0 && files.length === 0) {
    await write({
        ran: false,
        reason: `git named ${namedPaths.length} changed file(s) and none of them exist under ${repoRoot}`,
    });
    console.error("semgrep: none of the changed files are readable, skipped");
    process.exit(0);
}

if (files.length === 0) {
    await write({ ran: true, how: semgrep.how, scanned: 0 });
    console.log("semgrep: the diff touches no readable file");
    process.exit(0);
}

/**
 * The ruleset to scan under.
 *
 * A ruleset on disk has to sit inside the repository. On the container path semgrep sees
 * the repository at /src and nothing else, so an absolute host path resolves to nothing
 * there, and a relative one works only because the container's working directory is the
 * repository root. Anything that is not a path on disk is a registry identifier and goes
 * through as written.
 */
function ruleset(): { config: string } | { refusal: string } {
    const named = process.env.SEMGREP_CONFIG;

    if (!named) return { config: "p/default" };

    const resolved = resolve(repoRoot, named);

    if (!existsSync(resolved)) return { config: named };

    return resolved.startsWith(`${repoRoot}/`)
        ? { config: relative(repoRoot, resolved) }
        : {
              refusal:
                  `SEMGREP_CONFIG is '${named}', which resolves outside the repository.` +
                  " semgrep sees only the repository, so name a ruleset inside it.",
          };
}

const chosen = ruleset();

if ("refusal" in chosen) {
    await write({ ran: false, reason: chosen.refusal });
    console.error(`semgrep: ${chosen.refusal}`);
    process.exit(0);
}

const proc = Bun.spawnSync(
    [
        ...semgrep.argv,
        "--config",
        chosen.config,
        "--json",
        "--quiet",
        "--metrics",
        "off",
        // Every path here is one whoever opened the change chose, and a filename is
        // allowed to start with a dash. Without `--`, a file called
        // `--config=https://...` is a second ruleset and `--autofix` is a linter rewriting
        // the tree every lens is reading.
        "--",
        ...files,
    ],
    { cwd: repoRoot },
);

const stdout = new TextDecoder().decode(proc.stdout);
let parsed: {
    results?: Array<Record<string, any>>;
    errors?: Array<Record<string, any>>;
    paths?: { scanned?: unknown[]; skipped?: unknown[] };
};

try {
    parsed = JSON.parse(stdout);
} catch {
    const stderr = new TextDecoder().decode(proc.stderr).slice(0, 500);
    await write({ ran: false, reason: `semgrep returned no JSON: ${stderr}` });
    console.error(`semgrep: could not parse output, skipped`);
    process.exit(0);
}

const results = [...(parsed.results ?? [])].sort(
    (a, b) => severityRank(a.extra?.severity) - severityRank(b.extra?.severity),
);

// Semgrep parses what it can and skips the rest of a construct it cannot read, so a file
// in this list got less than a full scan. A count alone would leave the lens asserting
// coverage of files nothing read, so each one carries its path and the reason.
const allErrors = (parsed.errors ?? []).map((e) => ({
    path: e.path,
    message: String(e.message ?? "").slice(0, 300),
}));
const errors = allErrors.slice(0, MAX_ERRORS);

const findings = results.slice(0, MAX_FINDINGS).map((r) => ({
    rule: r.check_id,
    file: r.path,
    line: r.start?.line,
    end_line: r.end?.line,
    severity: r.extra?.severity,
    message: r.extra?.message,
}));

// Semgrep's own account of its target set, not the length of the argument list.
const analysed = Array.isArray(parsed.paths?.scanned) ? parsed.paths.scanned.length : files.length;
const skipped = Array.isArray(parsed.paths?.skipped) ? parsed.paths.skipped.length : 0;

await write({
    ran: true,
    how: semgrep.how,
    handed: files.length,
    scanned: analysed,
    skipped,
    raised: results.length,
    truncated: Math.max(0, results.length - findings.length),
    errors,
    errors_truncated: allErrors.length - errors.length,
    findings,
});

console.log(
    `semgrep: ${results.length} raised over ${analysed} of ${files.length} file(s)` +
        `${results.length > findings.length ? `, ${results.length - findings.length} beyond the cap` : ""}` +
        `${allErrors.length > 0 ? `, ${allErrors.length} file(s) only partly read` : ""}`,
);
