/**
 * Checks every `bun` a review starts for the flag that stops bun reading a config out of the
 * reviewed tree.
 *
 * `--config=/dev/null` is the whole of what stops bun running a `preload` script named by the
 * reviewed branch, and it is easy to leave off in a job holding both tokens. "Bun runs
 * whatever a `bunfig.toml` in the reviewed tree names" in review/DECISIONS.md has why nothing
 * else closes that route.
 *
 * A printed hint counts. Whoever pastes one is standing where the run left them.
 *
 * Not lint.yml or lefthook.yml: both run over a checkout of this repository, and lint.yml's
 * fork job holds no secrets and no write permissions, which is why it may run a fork's tests
 * at all.
 *
 * An invocation is matched as the pair `bun ... <a script this repository owns>`, and that
 * pairing is what separates one from the many other times these files write the word. Most of
 * those are prose, but throwing comment lines away is not enough on its own: `command -v bun`,
 * `say bun ok`, `bun@$BUN_VERSION` and `echo "bun and claude are already on PATH"` are all live
 * shell that names bun without running it, and every input description in action.yml that
 * mentions bun is a block scalar rather than a comment. So a rule reading "a bare `bun` must be
 * followed by the flag" trades this pairing for a maintained list of things that are not
 * invocations.
 *
 * The second half of the pair used to be a literal `.ts`, which stopped matching the one that
 * matters most the day `run_tool` in lib.sh took the script name as an argument: `bun
 * --config=/dev/null "$root/review/$script"` names no file the scanner could read, and three
 * invocations went behind that helper at once. A path under `review/` or `scripts/` counts as
 * well now, so a script named through a variable is still matched. The cost is that a comment
 * putting `bun` before such a path on one line is read as an invocation, which fails the
 * check. That is the right way round: a line anybody could paste has to carry the flag
 * whether it runs, prints or explains.
 *
 * What the pair still does not match is `bun run`, `bun test` and `bunx`, none of which a
 * review starts. Whoever writes the first one has to widen this again.
 *
 * The `.ts` files under review/ are matched by a pattern of their own, under the rule at the
 * top: a printed hint counts, and the one that broke it lived in check-findings.ts, which runs
 * inside every review and told its reader to run `bun scripts/validate-repo.ts` with no flag
 * and against a path that is not there. Only review/, because the scripts/ files run over a
 * checkout of this repository and take the exemption lint.yml takes.
 *
 * `HINT` rather than the pair above, which matches no hint at all: a line a reader can paste
 * names an absolute path, and the only way to write one here is to interpolate
 * `import.meta.dir`, which is not a script name any pattern matching one would find.
 *
 * What that leaves out is every `Usage: bun <script>.ts <arg>` synopsis these files open with,
 * and leaving them out is the point. A synopsis has placeholders and no directory, so it is
 * not a line anybody pastes.
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

/**
 * A `bun` command a `.ts` file prints for somebody to paste.
 *
 * The script is either an interpolation or the literal repository-relative path the shipped
 * defect was written as. The flags are read up to the first quote or backtick, so a match
 * cannot run out of the string it started in and pick up a `--config=` from the next line.
 */
const HINT = /\bbun\b([^\n`"']*?)(\$\{[^\n}]*\}|(?:review|scripts)\/[\w$/.-]*\.ts\b)/g;

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

        for (const match of text.matchAll(/\bbun\b([^\n]*?)([\w$"'{}/.-]*(?:\.ts\b|(?:review|scripts)\/[\w$"'{}/.-]*))/g)) {
            const [, flags, script] = match;
            const before = text.slice(text.lastIndexOf("\n", match.index) + 1, match.index);

            if (insideQuotes(before)) hints += 1;
            else invocations += 1;

            if (!String(flags).includes("--config=")) {
                fail(list, file, `runs \`bun ... ${script}\` with no --config=/dev/null`);
            }
        }
    }

    const printed = readdirSync("review")
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => `review/${f}`);

    let pasteable = 0;

    for (const file of printed) {
        for (const match of (await Bun.file(file).text()).matchAll(HINT)) {
            const [, flags, script] = match;

            pasteable += 1;

            if (!String(flags).includes("--config=")) {
                fail(list, file, `prints \`bun ... ${script}\` with no --config=/dev/null`);
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

    // The same argument for `HINT`, which is narrow enough to stop matching on an ordinary edit.
    if (pasteable === 0) {
        fail(list, "scripts/checks/bun-config.ts", "matched no printed bun command in review/, so it checked nothing");
    }

    if (list.length === 0) {
        console.log(
            `OK bun-config: ${invocations} bun invocation(s), ${hints} shell hint(s)` +
                ` and ${pasteable} printed command(s) in review/ name a config`,
        );
    }

    return list;
}
