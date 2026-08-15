/**
 * Every `bun` a review starts, against the flag that keeps the reviewed tree out of it.
 *
 * Bun runs the `preload` script named by the `bunfig.toml` in its working directory, before
 * the script on the command line. A review stands in the checkout it is reviewing, and the
 * orchestrator has `Bash` under `bypassPermissions` and knows every other directory a run
 * uses, so moving out of the tree only moves the problem. `--config=/dev/null` is the whole
 * control, and it is one flag to forget in a job holding `CLAUDE_CODE_OAUTH_TOKEN` and a
 * token that can write to pull requests.
 *
 * A printed hint counts. Whoever pastes one is standing where the run left them.
 *
 * Not lint.yml or lefthook.yml: both run over a checkout of this repository, and lint.yml's
 * fork job holds no secrets and no write permissions, which is why it may run a fork's tests
 * at all.
 */

import { readdirSync } from "node:fs";
import { fail } from "./support.ts";
import type { Failures } from "./support.ts";

/**
 * Whether a matched `bun` sits inside a string something prints.
 *
 * Counted apart from the invocations a script runs, and only for the guard at the end. Both
 * kinds are checked against the rule, but only a real invocation shows that the check is
 * still reaching anything: the hints would otherwise satisfy a non-empty test on their own,
 * after a refactor had taken every actual `bun` out of these files, and the check would go on
 * reporting compliance.
 *
 * A hint is an `echo` of a double-quoted string, so an odd number of unescaped quotes ahead
 * of the match is what separates the two. A hint written in single quotes would be counted as
 * an invocation, which is the safe direction: an invocation is the stricter of the two.
 */
function insideQuotes(before: string): boolean {
    return (before.match(/(?<!\\)"/g) ?? []).length % 2 === 1;
}

export async function checkBunConfig(): Promise<Failures> {
    const list: Failures = [];

    // Both script directories, not just review/. `scripts/vendor-lens.sh` runs bun too, and
    // being outside the scanned set is how its invocation went without the flag.
    const shell = ["review", "scripts"].flatMap((dir) =>
        readdirSync(dir)
            .filter((f) => f.endsWith(".sh"))
            .map((f) => `${dir}/${f}`),
    );

    const files = [...shell, "action.yml"];
    let invocations = 0;
    let hints = 0;

    for (const file of files) {
        // Line continuations joined first. Every long invocation in these scripts is written
        // over several lines with a trailing backslash, and a per-line match sees the flag
        // and the script name as two unrelated fragments: `bun \` matched nothing at all, so
        // the ones most worth checking were the ones being skipped.
        const text = (await Bun.file(file).text()).replace(/\\\n\s*/g, " ");

        for (const match of text.matchAll(/\bbun\b([^\n]*?)([\w$"'{}/.-]*\.ts)\b/g)) {
            const [, flags, script] = match;
            const before = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index);

            if (insideQuotes(before)) hints += 1;
            else invocations += 1;

            if (!String(flags).includes("--config=")) {
                fail(list, file, `runs \`bun ... ${script}\` with no --config=/dev/null`);
            }
        }
    }

    // A check that matched nothing has proved nothing. This is the only mechanical guard on
    // the rule, in a job holding both tokens, so silence here has to be a failure rather than
    // an OK line: a regex that stops matching would otherwise read exactly like compliance.
    //
    // Counted against the invocations alone. The printed hints match this pattern and carry
    // the flag, so a guard over the whole set was satisfied by lines that run nothing, and a
    // refactor taking every real `bun` out of these files would have read as compliance.
    if (invocations === 0) {
        fail(list, "scripts/checks/bun-config.ts", "matched no bun invocation at all, so it checked nothing");
    }

    if (list.length === 0) {
        console.log(`OK bun-config: ${invocations} bun invocation(s) and ${hints} printed hint(s) name a config`);
    }

    return list;
}
