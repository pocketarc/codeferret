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
 * so nobody has to put Python on a machine to review a diff. Neither one available is
 * written down and skipped, because a review that stops for want of a linter is worth
 * less than one that runs without it.
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
// pathological run would make one lens the most expensive thing in the review. Bounding
// the input is easier to justify than bounding what a reviewer gets told about.
const MAX_FINDINGS = 100;

// Pinned, for the reason every lens is pinned: a review job holds a write token, and
// what it runs should not change between runs. `-nonroot` so a bind mount does not come
// back owned by root.
const IMAGE = "semgrep/semgrep:1.172.0-nonroot";

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

async function write(report: Record<string, unknown>): Promise<void> {
    await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
}

// A container costs a 420MB pull the first time and nothing after, which beats asking
// somebody to put Python on their machine to review a diff. An installed semgrep wins,
// because it is faster and it is what a runner with the tool already set up will have.
function runner(): { argv: string[]; how: string } | null {
    if (Bun.which("semgrep")) return { argv: ["semgrep"], how: "binary" };

    if (Bun.which("docker")) {
        return {
            argv: [
                "docker",
                "run",
                "--rm",
                // Read-only, so the rule that lenses must not touch the working tree is
                // enforced by the kernel here rather than by asking nicely, which is all
                // that holds a lens back.
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
    await write({
        tool: "semgrep",
        ran: false,
        reason: "neither semgrep nor docker is on PATH",
        findings: [],
    });
    console.log("semgrep: no semgrep and no docker, skipped");
    process.exit(0);
}

// The same arguments the lenses' own diff uses, so the tool and the review never
// disagree about which files are under review.
const argsFile = join(buildDir, "diff-args");

if (!existsSync(argsFile)) {
    await write({ tool: "semgrep", ran: false, reason: `no ${argsFile}`, findings: [] });
    console.error(`semgrep: ${argsFile} is missing, skipped`);
    process.exit(0);
}

const diffArgs = (await Bun.file(argsFile).text()).split("\0").filter(Boolean);

// -d drops deleted files: semgrep cannot read what is no longer there.
const named = Bun.spawnSync(["git", "diff", "--name-only", "--diff-filter=d", ...diffArgs], {
    cwd: repoRoot,
});
const files = new TextDecoder()
    .decode(named.stdout)
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && existsSync(f));

if (files.length === 0) {
    await write({ tool: "semgrep", ran: true, scanned: 0, findings: [] });
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
    await write({ tool: "semgrep", ran: false, reason: `semgrep returned no JSON: ${stderr}`, findings: [] });
    console.error(`semgrep: could not parse output, skipped`);
    process.exit(0);
}

const results = parsed.results ?? [];

const findings = results.slice(0, MAX_FINDINGS).map((r) => ({
    rule: r.check_id,
    file: r.path,
    line: r.start?.line,
    end_line: r.end?.line,
    severity: r.extra?.severity,
    message: r.extra?.message,
}));

await write({
    tool: "semgrep",
    ran: true,
    how: semgrep.how,
    scanned: files.length,
    raised: results.length,
    truncated: Math.max(0, results.length - findings.length),
    errors: (parsed.errors ?? []).length,
    findings,
});

console.log(
    `semgrep: ${results.length} raised over ${files.length} file(s)` +
        `${results.length > findings.length ? `, ${results.length - findings.length} beyond the cap` : ""}`,
);
