/** That the preflight refuses to print a default branch name a shell would run. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "local-preflight.sh");

const RUNS_ON_SUBSTITUTION = "a$(id)b";

let root = "";

function repoDefaulting(name: string, branch: string): string {
    const cwd = join(root, name);

    const git = (...args: string[]): void => {
        const run = Bun.spawnSync(["git", "-c", "user.email=t@example.test", "-c", "user.name=t", ...args], { cwd });

        if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(run.stderr)}`);
    };

    Bun.spawnSync(["mkdir", "-p", cwd]);
    git("init", "-q", "-b", "main", ".");
    git("commit", "-q", "--allow-empty", "-m", "one");
    git("remote", "add", "origin", "https://example.invalid/x.git");
    git("update-ref", `refs/remotes/origin/${branch}`, "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);

    return cwd;
}

function preflight(cwd: string): Map<string, string> {
    const run = Bun.spawnSync(["bash", SCRIPT], {
        cwd,
        stdin: new TextEncoder().encode("\n"),
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: cwd },
    });

    const said = new Map<string, string>();

    for (const line of new TextDecoder().decode(run.stdout).split("\n")) {
        const at = line.indexOf("=");
        if (at > 0) said.set(line.slice(0, at), line.slice(at + 1));
    }

    return said;
}

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "codeferret-preflight-"));
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("local-preflight.sh: the default branch it reports", () => {
    test("prints an ordinary branch name as itself", () => {
        expect(preflight(repoDefaulting("plain", "develop")).get("default_branch")).toBe("develop");
    });

    test("prints a name that would run on substitution as `unsafe`", () => {
        const said = preflight(repoDefaulting("hostile", RUNS_ON_SUBSTITUTION));

        expect(said.get("default_branch")).toBe("unsafe");
        expect([...said.values()].some((v) => v.includes(RUNS_ON_SUBSTITUTION))).toBe(false);
    });

    test("prints `unknown` where origin names no default branch", () => {
        const cwd = join(root, "bare-origin");
        Bun.spawnSync(["mkdir", "-p", cwd]);
        Bun.spawnSync(["git", "init", "-q", "-b", "main", "."], { cwd });
        const identity = ["-c", "user.email=t@example.test", "-c", "user.name=t"];
        Bun.spawnSync(["git", ...identity, "commit", "-q", "--allow-empty", "-m", "one"], { cwd });

        expect(preflight(cwd).get("default_branch")).toBe("unknown");
    });
});
