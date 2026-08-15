/**
 * The generators, re-run with `--check`.
 *
 * `agents/`, `review/defaults/`, `review/standing-detail.ts` and `review/artifact.ts` are
 * generated, and re-running the generator is the only way to catch a hand edit to a file it
 * owns.
 *
 * A spawn rather than an import, unlike `finding-rules`. These are scripts with top-level
 * side effects rather than exported functions, and the failure they report is already a
 * sentence naming the file.
 */

import type { Failures } from "./support.ts";

export async function checkGenerated(): Promise<Failures> {
    const list: Failures = [];

    for (const generator of ["scripts/build-lens-agents.ts", "scripts/build-defaults.ts"]) {
        const run = Bun.spawnSync(["bun", generator, "--check"]);
        process.stdout.write(new TextDecoder().decode(run.stdout));

        if (run.exitCode !== 0) {
            const said = new TextDecoder().decode(run.stderr).trim();

            list.push(said === "" ? `${generator} exited ${run.exitCode} and wrote nothing to stderr` : said);
        }
    }

    return list;
}
