#!/usr/bin/env bun
/**
 * Run semgrep over the files this review's diff touches, and write down what it said.
 *
 * Nothing here judges whether a finding is real. A rule identifier and a line number are
 * not a review comment, and a rule that cannot read the surrounding code raises things
 * that are true of the pattern and false of this repository. Deciding which is which is
 * the `static-analysis` lens's job, and it is the reason tool output goes to a lens
 * rather than to the orchestrator: untriaged linter output posted to a pull request is
 * what makes an automated review unreadable.
 *
 * An installed semgrep is used if there is one, and a pinned container if there is not,
 * so nobody has to put Python on a machine to review a diff. The container costs a 420MB
 * pull the first time and nothing after. Neither one available is written down and
 * skipped, because a review that stops for want of a linter is worth less than one that
 * runs without it.
 *
 * The image is pinned; the ruleset is not. `p/default` is fetched from semgrep's
 * registry on each run, so what the tool looks for can change between two runs of the
 * same commit, and nobody here has read it. That sits awkwardly beside the rule that a
 * review job should only run what somebody could review. `SEMGREP_CONFIG` points at a
 * local ruleset for anyone who wants to close that.
 *
 * Usage: bun review/tools/semgrep.ts <build-dir>
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

// The lens reads every finding it is handed and checks it against the code, so a
// pathological run would make one lens the most expensive thing in the review.
const MAX_FINDINGS = 100;

// Pinned, for the reason every lens is pinned: a review job holds a write token, and what
// it runs should not change between runs. A tag is a mutable pointer, so the digest is the
// pin and the tag is there to be read. `-nonroot` so a bind mount does not come back owned
// by root.
const IMAGE =
    "semgrep/semgrep:1.172.0-nonroot@sha256:d1012a3bf2acf47721216fbf7ff12d4c2971cc7f9c7b77cf6c6e9dcf006bd487";

const [buildDir] = process.argv.slice(2);

if (!buildDir) {
    console.error("usage: bun review/tools/semgrep.ts <build-dir>");
    process.exit(2);
}

const out = join(buildDir, "tool-semgrep.json");

// git prints paths from the repository root, and a finding has to anchor against one, so
// everything below runs from there rather than from wherever the caller happened to be.
const topLevel = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
const repoRoot = new TextDecoder().decode(topLevel.stdout).trim() || process.cwd();

// Every exit writes the same keys, because the lens is asked to say how many findings the
// report held and whether the tool ran at all. It cannot answer that from a shape that
// changes with the path taken, and it cannot tell `{ran: true, scanned: 0}` from a report
// that lost its counts.
async function write(report: Record<string, unknown>): Promise<void> {
    const full = {
        tool: "semgrep",
        ran: false,
        how: null,
        reason: null,
        scanned: 0,
        raised: 0,
        truncated: 0,
        errors: [],
        findings: [],
        ...report,
    };
    await Bun.write(out, `${JSON.stringify(full, null, 2)}\n`);
}

function runner(): { argv: string[]; how: string } | null {
    if (Bun.which("semgrep")) return { argv: ["semgrep"], how: "binary" };

    if (Bun.which("docker")) {
        return {
            argv: [
                "docker",
                "run",
                "--rm",
                // Read-only: a linter has no business writing to the tree.
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

const proc = Bun.spawnSync(
    [
        ...semgrep.argv,
        "--config",
        process.env.SEMGREP_CONFIG ?? "p/default",
        "--json",
        "--quiet",
        "--metrics",
        "off",
        // Every path here is one whoever opened the change chose, and a filename is
        // allowed to start with a dash. Without `--`, a file called
        // `--config=https://...` is a second ruleset and `--autofix` is a linter rewriting
        // the tree ten lenses are reading.
        "--",
        ...files,
    ],
    { cwd: repoRoot },
);

const stdout = new TextDecoder().decode(proc.stdout);
let parsed: { results?: Array<Record<string, any>>; errors?: Array<Record<string, any>> };

try {
    parsed = JSON.parse(stdout);
} catch {
    const stderr = new TextDecoder().decode(proc.stderr).slice(0, 500);
    await write({ ran: false, reason: `semgrep returned no JSON: ${stderr}` });
    console.error(`semgrep: could not parse output, skipped`);
    process.exit(0);
}

const results = parsed.results ?? [];

// Semgrep parses what it can and skips the rest of a construct it cannot read, so a file
// in this list got less than a full scan. A count alone would leave the lens asserting
// coverage of files nothing read, so each one carries its path and the reason.
const errors = (parsed.errors ?? []).map((e) => ({
    path: e.path,
    message: String(e.message ?? "").slice(0, 300),
}));

const findings = results.slice(0, MAX_FINDINGS).map((r) => ({
    rule: r.check_id,
    file: r.path,
    line: r.start?.line,
    end_line: r.end?.line,
    severity: r.extra?.severity,
    message: r.extra?.message,
}));

await write({
    ran: true,
    how: semgrep.how,
    scanned: files.length,
    raised: results.length,
    truncated: Math.max(0, results.length - findings.length),
    errors,
    findings,
});

console.log(
    `semgrep: ${results.length} raised over ${files.length} file(s)` +
        `${results.length > findings.length ? `, ${results.length - findings.length} beyond the cap` : ""}` +
        `${errors.length > 0 ? `, ${errors.length} file(s) only partly read` : ""}`,
);
