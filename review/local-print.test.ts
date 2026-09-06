/**
 * What `local-print.sh` starts the printer with.
 *
 * `gh_credentials` puts a developer's own token in the script's environment, and
 * print-findings.ts never needs it: everything it does need arrives on stdin or as an
 * argument, so the environment after the `exec` is the one thing here a test can pin.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN = join(import.meta.dir, "..");

const TOKEN = "not-a-real-token";

let root = "";
let bin = "";
let env = "";

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "codeferret-print-"));
    bin = join(root, "bin");
    env = join(root, "printer-env.txt");
    mkdirSync(bin);

    const stub = (name: string, body: string): void => {
        const path = join(bin, name);
        writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
        chmodSync(path, 0o755);
    };

    stub("bun", `printenv >'${env}'`);
    stub(
        "gh",
        ['case "$1" in', `auth) printf '%s\\n' '${TOKEN}' ;;`, "repo) printf 'owner/name\\n' ;;", "*) exit 1 ;;", "esac"].join(
            "\n",
        ),
    );

    const run = Bun.spawnSync(["git", "init", "--quiet", "--initial-branch", "main", root]);
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));

    // What `require_checked_findings` asks for, under the directory `session_run_dir` derives
    // from the git dir.
    const build = join(root, ".git", "codeferret", "run", "build");
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "findings.json"), '{"summary": "s", "findings": [], "lens_health": []}\n');
    writeFileSync(join(build, "findings-checked"), "ok");
});

afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
});

describe("local-print.sh: what the printer is started with", () => {
    test("keeps the developer's own gh token out of the printer's environment", () => {
        const ran = Bun.spawnSync(["bash", join(PLUGIN, "review", "local-print.sh"), PLUGIN], {
            cwd: root,
            env: {
                PATH: `${bin}:${process.env.PATH ?? ""}`,
                HOME: process.env.HOME ?? "",
                GH_TOKEN: TOKEN,
            },
        });

        expect(ran.exitCode).toBe(0);
        expect(readFileSync(env, "utf8")).not.toContain(TOKEN);
    });
});
