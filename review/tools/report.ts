/**
 * The shape every static analysis report is written in, and the work every tool repeats
 * to produce one.
 *
 * The `static-analysis` lens is asked to account for what each report held and whether
 * the tool ran at all, and it cannot do that from a shape that changes with the path the
 * tool took. Two object literals held that contract by hand until this module took it
 * over: a misspelled key had produced a report the lens treated as a clean result.
 *
 * There is no index signature on `ToolReport`, because one turns off the excess-property
 * check that is the whole point: `write({ ran: true, hwo: "binary" })` compiled, the
 * defaults filled `how` and `scanned: 0` behind it, and the lens read a clean scan. Each
 * tool's own keys are typed instead, inferred from the defaults it passes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

// The lens reads every finding it is handed and checks it against the code, so a
// pathological run would make one lens the most expensive thing in the review. Each tool
// sorts before it cuts, so the cap takes the low end.
export const MAX_FINDINGS = 100;

export interface ToolReport {
    tool: string;
    /** False means nothing was scanned, whatever else the report says. `reason` says why. */
    ran: boolean;
    /** How the tool was run: a binary on PATH, or a digest-pinned container. */
    how: string | null;
    reason: string | null;
    /** What the tool analysed. Each tool decides its own scope. */
    scanned: number;
    /** Everything the tool raised, before the cap above. */
    raised: number;
    /** How many of those did not fit. The report is sorted so these are the low end. */
    truncated: number;
    findings: Array<Record<string, unknown>>;
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
        findings: [],
        ...extra,
    };

    return async (report) => {
        await Bun.write(out, `${JSON.stringify({ ...defaults, ...report }, null, 2)}\n`);
    };
}

let root: string | null = null;

/** The repository root, because git prints paths relative to it and a finding anchors on one. */
export function repoRoot(): string {
    if (root === null) {
        const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
        root = new TextDecoder().decode(proc.stdout).trim() || process.cwd();
    }

    return root;
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
    command?: string,
): { argv: string[]; how: string } | null {
    if (Bun.which(binary)) return { argv: [binary], how: "binary" };

    if (Bun.which("docker")) {
        const argv = ["docker", "run", "--rm", "--volume", `${repoRoot()}:/src:ro`, "--workdir", "/src", image];
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
export function changedFiles(args: string[]): Changed | { failure: string } {
    const proc = Bun.spawnSync(["git", "diff", "--name-only", "-z", "--diff-filter=d", ...args], {
        cwd: repoRoot(),
    });

    if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr).trim().slice(0, 300);
        return { failure: `git diff failed: ${stderr || `exit ${proc.exitCode}`}` };
    }

    const named = new TextDecoder().decode(proc.stdout).split("\0").filter(Boolean);

    return { named, present: named.filter((f) => existsSync(join(repoRoot(), f))) };
}
