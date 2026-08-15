/**
 * action.yml's `run:` blocks, through shellcheck.
 *
 * They are the only shell in the repository that lives as a string inside YAML, so nothing
 * else reads them before a real run does: GitHub validates workflow syntax on push and
 * validates an action manifest only when a run loads it. "Before you push" in CLAUDE.md has
 * what has already shipped that way.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { action, fail } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkActionShell(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await action(list);
    if (!manifest) return list;

    // A machine without shellcheck prints a line and skips the check: this script is what
    // a maintainer runs before pushing, and CI has the linter.
    if (!Bun.which("shellcheck")) {
        console.log("-- action.yml: no shellcheck on PATH, its shell steps went unchecked");
        return list;
    }

    const steps = (manifest.runs?.steps ?? []).filter((step) => step.shell === "bash" && step.run);

    // A fresh directory per run, because a predictable name under a shared /tmp is one
    // another local user can pre-create as a symlink onto a file this then overwrites.
    const dir = mkdtempSync(join(tmpdir(), "codeferret-"));

    try {
        for (const [i, step] of steps.entries()) {
            const name = step.name ?? "unnamed";
            const file = join(dir, `step-${i + 1}.sh`);
            await Bun.write(file, `#!/usr/bin/env bash\n${step.run}`);

            // SC2016 for the same reason the workflow passes it: these blocks printf
            // markdown, and a backtick in a single-quoted format is not an expansion.
            //
            // `-x` with the repository root as the source path, because a step is written
            // out to a temporary file and a `# shellcheck source=` directive in it would
            // otherwise resolve nowhere. The steps that source review/lib.sh for the helper
            // that writes their outputs are the ones the check exists to cover.
            const run = Bun.spawnSync(["shellcheck", "-e", "SC2016", "-x", `--source-path=${process.cwd()}`, file]);
            if (run.exitCode !== 0) {
                fail(list, "action.yml", `shellcheck on step '${name}':\n${new TextDecoder().decode(run.stdout)}`);
            }
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(`OK action.yml: ${steps.length} shell step(s) pass shellcheck`);
    return list;
}
