#!/usr/bin/env bun
/**
 * Look up the dependency manifests this diff changed against the OSV vulnerability
 * database, and write down what it says.
 *
 * This is the one thing no lens can do. A model does not know whether an advisory landed
 * last week, and will not say so; a database lookup does. Everything else in the tool
 * layer is a second opinion on ground the lenses already cover.
 *
 * The lookup goes to osv.dev, so the package names and versions in every changed lockfile
 * leave the runner. Run this tool nowhere that matters.
 *
 * It scans a different set of files from every lens, on purpose. `exclude-paths` keeps
 * lockfiles out of the review because nobody wants a reviewer reading one, and a lockfile
 * is exactly what this needs. So the range comes from the run's own diff (the same commits
 * the lenses read) and the pathspec beside it is dropped. Each tool has its own scope;
 * `exclude-paths` is about what deserves a reader's attention, not a machine's.
 *
 * Usage: bun review/tools/osv-scanner.ts <build-dir>
 */

import { basename, join } from "node:path";
import { readDiffArgs } from "../lib.ts";
import { changedFiles, MAX_FINDINGS, repoRoot, reporter, runner } from "./report.ts";

const IMAGE =
    "ghcr.io/google/osv-scanner:v2.2.4@sha256:f7ba4be68bac8086b1f88fd598fdca1ca67239c79ad2c2b5c78e03a82e5187c4";

// What OSV can read. A name not on this list is not a manifest, and scanning the whole
// tree instead would report the repository rather than the change. `bun.lockb` is not
// here: it is Bun's binary lockfile, v2.2.4 answers it with "could not determine extractor
// suitable to this file", and every name on this list was checked against that release.
const MANIFESTS = new Set([
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
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

/**
 * The part of the scanner's JSON this reads.
 *
 * Declared rather than left as `any`. The image is pinned by digest but the shape is
 * upstream's, and under `any` a renamed field empties every field of every finding while
 * the report still says the tool ran with the right count. The counter below turns that
 * into something the lens can see.
 */
interface ScanPackage {
    package?: { name?: string; version?: string; ecosystem?: string };
    vulnerabilities?: Array<{ id?: string; aliases?: string[]; summary?: string }>;
    groups?: Array<{ ids?: string[]; max_severity?: string }>;
}

interface ScanOutput {
    results?: Array<{ packages?: ScanPackage[] }>;
}

const [buildDir] = process.argv.slice(2);

if (!buildDir) {
    console.error("usage: bun review/tools/osv-scanner.ts <build-dir>");
    process.exit(2);
}

const root = repoRoot();

// One `manifests` entry per lockfile, so a scan that failed on one and succeeded on
// another is legible rather than a single number.
const extras: { manifests: Array<Record<string, unknown>>; caveat: string } = {
    manifests: [],
    caveat:
        "A lockfile holds every dependency, not only the ones this diff touched, so a" +
        " vulnerability here may predate the change. Check the diff before blaming it on" +
        " this pull request.",
};

const write = reporter("osv-scanner", join(buildDir, "tool-osv-scanner.json"), extras);

// The image's entrypoint is the scanner itself, so it takes arguments and no command.
const osv = runner("osv-scanner", IMAGE);

if (!osv) {
    await write({ ran: false, reason: "neither osv-scanner nor docker is on PATH" });
    console.log("osv-scanner: no osv-scanner and no docker, skipped");
    process.exit(0);
}

const argsFile = join(buildDir, "diff-args");
let range: string;

try {
    // The range only. This tool drops the pathspec beside it, for the reason at the top
    // of this file.
    ({ range } = await readDiffArgs(argsFile));
} catch (error) {
    await write({ ran: false, reason: error instanceof Error ? error.message : String(error) });
    console.error(`osv-scanner: ${argsFile} could not be read, skipped`);
    process.exit(0);
}

const changed = changedFiles([range]);

// Left unchecked, the only check on dependency advisories would report itself as having
// run and found nothing.
if ("failure" in changed) {
    await write({ ran: false, reason: changed.failure });
    console.error("osv-scanner: git diff failed, skipped");
    process.exit(0);
}

const manifests = changed.present.filter((f) => MANIFESTS.has(basename(f)));

if (manifests.length === 0) {
    await write({ ran: true, how: osv.how, scanned: 0 });
    console.log("osv-scanner: the diff changes no dependency manifest");
    process.exit(0);
}

// One invocation per manifest, rather than one carrying all of them. Handed several, the
// scanner exits non-zero and writes nothing at all once one file fails to parse: a
// `bun.lockb` in the diff took a valid `package-lock.json` down with it, exit 127 and an
// empty stdout, and the report then said the tool had not run. A failure should cost only
// the manifest it belongs to. The price is a process per manifest, and a diff that changes
// more than two or three of them is not the usual case.
const findings: Array<Record<string, unknown>> = [];
const attempts: Array<Record<string, unknown>> = [];

for (const manifest of manifests) {
    // `--lockfile=` rather than a separate argument, so that a later edit cannot separate
    // the flag from its value and leave a repository-controlled path being read as one.
    const proc = Bun.spawnSync([...osv.argv, "scan", "source", "--format", "json", `--lockfile=${manifest}`], {
        cwd: root,
    });

    // It exits non-zero when it finds something, which is the normal case here, so the
    // code is recorded rather than read. Whether stdout is valid JSON is the signal.
    let parsed: ScanOutput;

    try {
        parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as ScanOutput;
    } catch {
        const stderr = new TextDecoder().decode(proc.stderr).trim().slice(0, 300);
        attempts.push({
            manifest,
            ok: false,
            exit: proc.exitCode,
            detail: stderr || "no JSON on stdout",
        });
        console.error(`osv-scanner: ${manifest} could not be scanned (exit ${proc.exitCode})`);
        continue;
    }

    let unreadable = 0;

    for (const result of parsed.results ?? []) {
        for (const pkg of result.packages ?? []) {
            for (const vuln of pkg.vulnerabilities ?? []) {
                // Both are always present in v2.2.4's output, so an absence here is the
                // shape having moved rather than a vulnerability with no identity.
                if (!vuln.id || !pkg.package?.name) unreadable += 1;

                findings.push({
                    rule: vuln.id,
                    // The path the scanner echoes back is the bind mount's when it ran in
                    // the container and the host's when it ran as a binary, and a reader
                    // can open neither. The manifest this invocation was handed is
                    // repo-relative, which is what every other path in a review is.
                    file: manifest,
                    // OSV reports a package, not a position. Where to point is a judgement
                    // the lens makes: the line where this dependency is declared is worth
                    // more to a reader than the first line of a lockfile.
                    line: null,
                    package: pkg.package?.name,
                    version: pkg.package?.version,
                    ecosystem: pkg.package?.ecosystem,
                    severity: pkg.groups?.find((g) => vuln.id !== undefined && g.ids?.includes(vuln.id))
                        ?.max_severity,
                    aliases: vuln.aliases,
                    message: vuln.summary,
                });
            }
        }
    }

    attempts.push({
        manifest,
        ok: true,
        exit: proc.exitCode,
        ...(unreadable > 0
            ? { detail: `${unreadable} entries had no id or no package name; the scanner's output shape has moved` }
            : {}),
    });
}

const succeeded = attempts.filter((a) => a.ok);
const failed = attempts.filter((a) => !a.ok);

if (succeeded.length === 0) {
    await write({
        ran: false,
        how: osv.how,
        reason: `no manifest could be scanned: ${failed.map((f) => `${f.manifest} (${f.detail})`).join("; ")}`,
        manifests: attempts,
    });
    console.error(`osv-scanner: all ${manifests.length} manifest(s) failed, skipped`);
    process.exit(0);
}

// Highest severity first, so the cap takes the low end rather than whatever the scanner
// happened to emit last. `max_severity` is a CVSS score as a string, and an entry without
// one sorts to the back.
const kept = [...findings]
    .sort((a, b) => (Number(b.severity) || -1) - (Number(a.severity) || -1))
    .slice(0, MAX_FINDINGS);

await write({
    ran: true,
    how: osv.how,
    scanned: succeeded.length,
    manifests: attempts,
    raised: findings.length,
    truncated: findings.length - kept.length,
    findings: kept,
});

console.log(
    `osv-scanner: ${findings.length} raised over ${succeeded.length} manifest(s)` +
        `${failed.length > 0 ? `, ${failed.length} could not be scanned` : ""}` +
        `${findings.length > kept.length ? `, ${findings.length - kept.length} beyond the cap` : ""}`,
);
