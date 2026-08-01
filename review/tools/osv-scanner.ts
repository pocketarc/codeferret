#!/usr/bin/env bun
/**
 * Look up the dependency manifests this diff changed against the OSV vulnerability
 * database, and write down what it says.
 *
 * This is the one thing no lens can do. A model does not know whether an advisory landed
 * last week, and will not say so; a database lookup does. Everything else in the tool
 * layer is a second opinion on ground the lenses already cover.
 *
 * It scans a different set of files from every lens, on purpose. `exclude-paths` keeps
 * lockfiles out of the review because nobody wants a reviewer reading one, and a lockfile
 * is exactly what this needs. So the range comes from the run's own diff — the same
 * commits the lenses read — and the pathspec beside it is deliberately dropped. Each tool
 * decides its own scope; `exclude-paths` is about what deserves a reader's attention, not
 * a machine's.
 *
 * One caveat travels with every finding: a lockfile carries every dependency, not only
 * the ones this diff touched, so a vulnerability here may predate the change entirely.
 * Working out which is which is the static-analysis lens's job, and it has the diff.
 *
 * Usage: bun review/tools/osv-scanner.ts <build-dir>
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

const MAX_FINDINGS = 100;

// Pinned, like every lens and every other tool.
const IMAGE = "ghcr.io/google/osv-scanner:v2.2.4";

// What OSV can read. A name not on this list is not a manifest, and scanning the whole
// tree instead would report the repository rather than the change.
const MANIFESTS = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "composer.lock",
    "Gemfile.lock",
    "poetry.lock",
    "Pipfile.lock",
    "requirements.txt",
    "go.mod",
    "Cargo.lock",
    "mix.lock",
    "pubspec.lock",
    "gradle.lockfile",
    "pom.xml",
    "conan.lock",
    "renv.lock",
]);

const [buildDir] = process.argv.slice(2);

if (!buildDir) {
    console.error("usage: bun review/tools/osv-scanner.ts <build-dir>");
    process.exit(2);
}

const out = join(buildDir, "tool-osv-scanner.json");

const topLevel = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
const repoRoot = new TextDecoder().decode(topLevel.stdout).trim() || process.cwd();

async function write(report: Record<string, unknown>): Promise<void> {
    await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
}

function runner(): { argv: string[]; how: string } | null {
    if (Bun.which("osv-scanner")) return { argv: ["osv-scanner"], how: "binary" };

    if (Bun.which("docker")) {
        // The image's entrypoint is the scanner itself, so it takes arguments and no
        // command. Read-only: it has no business writing to the tree.
        return {
            argv: ["docker", "run", "--rm", "--volume", `${repoRoot}:/src:ro`, "--workdir", "/src", IMAGE],
            how: `docker ${IMAGE}`,
        };
    }

    return null;
}

const osv = runner();

if (!osv) {
    await write({
        tool: "osv-scanner",
        ran: false,
        reason: "neither osv-scanner nor docker is on PATH",
        findings: [],
    });
    console.log("osv-scanner: no osv-scanner and no docker, skipped");
    process.exit(0);
}

const argsFile = join(buildDir, "diff-args");

if (!existsSync(argsFile)) {
    await write({ tool: "osv-scanner", ran: false, reason: `no ${argsFile}`, findings: [] });
    console.error(`osv-scanner: ${argsFile} is missing, skipped`);
    process.exit(0);
}

// Element one is the range. Everything after it is the pathspec the lenses review under,
// and taking it would hide every lockfile from the one tool that needs them.
const range = (await Bun.file(argsFile).text()).split("\0").filter(Boolean)[0];

if (!range) {
    await write({ tool: "osv-scanner", ran: false, reason: "no range in diff-args", findings: [] });
    console.error("osv-scanner: diff-args names no range, skipped");
    process.exit(0);
}

const named = Bun.spawnSync(["git", "diff", "--name-only", "--diff-filter=d", range], { cwd: repoRoot });
const manifests = new TextDecoder()
    .decode(named.stdout)
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && MANIFESTS.has(basename(f)) && existsSync(join(repoRoot, f)));

if (manifests.length === 0) {
    await write({ tool: "osv-scanner", ran: true, how: osv.how, scanned: 0, raised: 0, findings: [] });
    console.log("osv-scanner: the diff changes no dependency manifest");
    process.exit(0);
}

const proc = Bun.spawnSync(
    [...osv.argv, "scan", "source", "--format", "json", ...manifests.flatMap((m) => ["--lockfile", m])],
    { cwd: repoRoot },
);

// It exits non-zero when it finds something, which is the normal case here.
const stdout = new TextDecoder().decode(proc.stdout);
let parsed: { results?: Array<Record<string, any>> };

try {
    parsed = JSON.parse(stdout);
} catch {
    const stderr = new TextDecoder().decode(proc.stderr).slice(0, 500);
    await write({
        tool: "osv-scanner",
        ran: false,
        reason: `osv-scanner returned no JSON: ${stderr}`,
        findings: [],
    });
    console.error("osv-scanner: could not parse output, skipped");
    process.exit(0);
}

const findings: Array<Record<string, unknown>> = [];

for (const result of parsed.results ?? []) {
    const path = String(result.source?.path ?? "").replace(/^\/src\//, "");

    for (const pkg of result.packages ?? []) {
        for (const vuln of pkg.vulnerabilities ?? []) {
            findings.push({
                rule: vuln.id,
                file: path,
                // OSV reports a package, not a position. Anchoring it is a judgement the
                // lens makes: the line where this dependency is declared is worth more to
                // a reader than the first line of a lockfile.
                line: null,
                package: pkg.package?.name,
                version: pkg.package?.version,
                ecosystem: pkg.package?.ecosystem,
                severity: pkg.groups?.find((g: any) => g.ids?.includes(vuln.id))?.max_severity,
                aliases: vuln.aliases,
                message: vuln.summary,
            });
        }
    }
}

const kept = findings.slice(0, MAX_FINDINGS);

await write({
    tool: "osv-scanner",
    ran: true,
    how: osv.how,
    scanned: manifests.length,
    manifests,
    raised: findings.length,
    truncated: findings.length - kept.length,
    caveat:
        "A lockfile holds every dependency, not only the ones this diff touched, so a" +
        " vulnerability here may predate the change. Check the diff before blaming it on" +
        " this pull request.",
    findings: kept,
});

console.log(
    `osv-scanner: ${findings.length} raised over ${manifests.length} manifest(s)` +
        `${findings.length > kept.length ? `, ${findings.length - kept.length} beyond the cap` : ""}`,
);
