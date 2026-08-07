/**
 * The shape every static analysis report is written in, and the work every tool repeats
 * to produce one.
 *
 * The `static-analysis` lens is asked to account for what each report held and whether
 * the tool ran at all, and it cannot do that from a shape that changes with the path the
 * tool took. So the shape is declared here rather than written out at each exit, where a
 * misspelled key produced a report the lens read as a clean result.
 *
 * There is no index signature on `ToolReport`, because one turns off the excess-property
 * check that is the whole point: `write({ ran: true, hwo: "binary" })` compiled, the
 * defaults filled `how` and `scanned: 0` behind it, and the lens read a clean scan. Each
 * tool's own keys are typed instead, inferred from the defaults it passes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readDiffArgs } from "../diff-args.ts";
import { reason } from "../json.ts";

// The lens reads every finding it is handed and checks it against the code, so a
// pathological run would make one lens the most expensive thing in the review. Each tool
// sorts before it cuts, so the cap takes the low end.
export const MAX_FINDINGS = 100;

// Linux caps a single argument at 128 KiB and the whole argument list at around 2 MiB, so a
// large refactor spread over enough paths fails a spawn outright with E2BIG. A scan is split
// into batches to survive that, and they are sized well under the limit because the
// environment shares that budget.
export const MAX_ARGV_CHARS = 100_000;

/** Path lists sized so that one spawn cannot exceed the kernel's argument limit. */
export function argvBatches(files: string[]): string[][] {
    const out: string[][] = [];
    let current: string[] = [];
    let size = 0;

    for (const file of files) {
        if (current.length > 0 && size + file.length + 1 > MAX_ARGV_CHARS) {
            out.push(current);
            current = [];
            size = 0;
        }

        current.push(file);
        size += file.length + 1;
    }

    if (current.length > 0) out.push(current);

    return out;
}

export interface ToolReport {
    tool: string;
    /** False means nothing was scanned, whatever else the report says. `reason` says why. */
    ran: boolean;
    /** How the tool was run: a binary on PATH, or a digest-pinned container. */
    how: string | null;
    reason: string | null;
    /** Each tool decides its own scope. */
    scanned: number;
    raised: number;
    /** The report is sorted so that what did not fit is the low end. */
    truncated: number;
    /**
     * What this run sent off the runner, in the tool's own words, or null where it sent
     * nothing.
     *
     * Written by the invocation that made the request rather than derived from the tool's
     * name, because whether a tool reached the network is a property of the run: a scan with
     * no lockfile in the diff looks up nothing, and a semgrep pointed at a ruleset on disk
     * fetches nothing. summary.ts reports this to a maintainer, and a disclosure that is
     * wrong in either direction stops being read.
     */
    egress: string | null;
    findings: Array<Record<string, unknown>>;
}

/**
 * Where a tool's report goes. Named once, because the `static-analysis` lens is pointed at
 * this glob in review/lens-extras/static-analysis.md and `keepRaised` has to stay outside it.
 */
export function reportPath(tool: string, buildDir: string): string {
    return join(buildDir, `tool-${tool}.json`);
}

/**
 * A writer bound to one tool's output file, spreading each partial report over the same
 * defaults so that every exit writes every key.
 */
export function reporter<Extra extends Record<string, unknown>>(
    tool: string,
    out: string,
    extra: Extra,
): (report: Partial<ToolReport & Extra>) => Promise<void> {
    const defaults = {
        tool,
        ran: false,
        how: null,
        reason: null,
        scanned: 0,
        raised: 0,
        truncated: 0,
        egress: null,
        findings: [],
        ...extra,
    };

    return async (report) => {
        await Bun.write(out, `${JSON.stringify({ ...defaults, ...report }, null, 2)}\n`);
    };
}

/**
 * The repository root, because git prints paths relative to it and a finding anchors on one.
 *
 * The workspace is handed in, because no `bun` a run starts may have the reviewed tree as
 * its own. The comment on `cd "$BUILD"` in run.sh has why.
 *
 * Under a command prefix the tool runs inside a container where the host's workspace path
 * does not exist, and that prefix is required to start in the repository root, so there git
 * is asked from wherever the prefix put it.
 */
export function repoRoot(workspace: string): string {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
        ...(existsSync(workspace) ? { cwd: workspace } : {}),
    });

    return new TextDecoder().decode(proc.stdout).trim() || workspace;
}

/**
 * How to run a tool: its own binary where there is one, a digest-pinned container where
 * there is not, and null where there is neither.
 *
 * A review job holds a write token, so what it runs should not change between runs, which
 * is why the image is pinned by digest. `command` is the word after the image, for an
 * image whose entrypoint is not already the tool.
 */
export function runner(
    binary: string,
    image: string,
    root: string,
    command?: string,
): { argv: string[]; how: string } | null {
    if (Bun.which(binary)) return { argv: [binary], how: "binary" };

    if (Bun.which("docker")) {
        const argv = ["docker", "run", "--rm", "--volume", `${root}:/src:ro`, "--workdir", "/src", image];
        if (command) argv.push(command);

        return { argv, how: `docker ${image}` };
    }

    return null;
}

export interface Changed {
    /** Every path git named, whether or not it is on disk. */
    named: string[];
    /** The subset that exists, joined to the repository root git printed them relative to. */
    present: string[];
}

/**
 * The files a diff touches, deletions dropped: a tool cannot read what is no longer there.
 *
 * `-z` because git backslash-quotes any path outside ASCII unless it is asked not to, and
 * a quoted path matches no file on disk, so those files would drop out of a scan without a
 * word. A failing `git diff` writes nothing to stdout, which is the same shape as a diff
 * touching no file, so the failure comes back rather than reading as a clean zero.
 */
export function changedFiles(args: string[], root: string): Changed | { failure: string } {
    const proc = Bun.spawnSync(["git", "diff", "--name-only", "-z", "--diff-filter=d", ...args], {
        cwd: root,
    });

    if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr).trim().slice(0, 300);
        return { failure: `git diff failed: ${stderr || `exit ${proc.exitCode}`}` };
    }

    const named = new TextDecoder().decode(proc.stdout).split("\0").filter(Boolean);

    return { named, present: named.filter((f) => existsSync(join(root, f))) };
}

/**
 * Everything a tool needs before it can scan, and every way that can end in a skip.
 *
 * `usePathspec` is where the tools differ: semgrep reads the same files the lenses do, and
 * osv-scanner drops the pathspec because the `exclude-paths` default names every lockfile.
 * Every exit from here writes a report. An exit that wrote none would leave the lens with
 * silence it cannot tell from a clean scan.
 *
 * Null means the refusal is already written and the caller has nothing left to do but
 * `process.exit(0)`. A tool's file name has to match the binary it looks for, because that
 * name is what `runner` searches PATH for.
 */
export async function startTool(spec: {
    tool: string;
    image: string;
    /** The word after the image, for an image whose entrypoint is not already the tool. */
    command?: string;
    buildDir: string;
    root: string;
    usePathspec: boolean;
    write: (report: Partial<ToolReport>) => Promise<void>;
}): Promise<{ how: string; argv: string[]; changed: Changed } | null> {
    const { root, write } = spec;
    const how = runner(spec.tool, spec.image, root, spec.command);

    if (!how) {
        await write({ ran: false, reason: `neither ${spec.tool} nor docker is on PATH` });
        console.log(`${spec.tool}: no ${spec.tool} and no docker, skipped`);
        return null;
    }

    // The same arguments the lenses' own diff uses, so a tool and the review never disagree
    // about which files are under review.
    const argsFile = join(spec.buildDir, "diff-args");
    let args: string[];

    try {
        const { range, pathspec } = await readDiffArgs(argsFile);
        args = spec.usePathspec ? [range, ...pathspec] : [range];
    } catch (error) {
        await write({ ran: false, reason: reason(error) });
        console.error(`${spec.tool}: ${argsFile} could not be read, skipped`);
        return null;
    }

    const changed = changedFiles(args, root);

    // Left unchecked, a tool would report itself as having run and found nothing.
    if ("failure" in changed) {
        await write({ ran: false, reason: changed.failure });
        console.error(`${spec.tool}: git diff failed, skipped`);
        return null;
    }

    return { how: how.how, argv: how.argv, changed };
}

/**
 * The whole list a tool raised, beside the capped report the lens reads.
 *
 * `tool-<name>.json` is the lens's input and is capped, so past `MAX_FINDINGS` it is not
 * also the record. The record is what makes the lens auditable: it may drop a tool finding
 * only because both the capped list it was handed and the full list it was not survive here.
 *
 * Named outside `tool-*.json` deliberately. That glob is the one the `static-analysis` lens
 * is told to read, in review/lens-extras/static-analysis.md, so a file matching it would
 * hand back the whole list the cap exists to keep out.
 */
export async function keepRaised(tool: string, buildDir: string, raised: unknown[]): Promise<void> {
    if (raised.length <= MAX_FINDINGS) return;

    await Bun.write(join(buildDir, `raised-${tool}.json`), `${JSON.stringify({ tool, raised }, null, 2)}\n`);
}
