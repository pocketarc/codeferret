/**
 * What `run.sh` reports about a session that rewrote what it was handed.
 *
 * The comparison decides the content of a `[!WARNING]` block in a posted review, and nothing
 * ran it: `bun test` reaches no shell, and the bash 3.2 workarounds in there, the
 * `${arr[@]+…}` guard and the per-entry `:-`, had nothing exercising them.
 * `refuse-fork.test.ts` is the precedent for the answer: run the script.
 *
 * The digests have to stay in the shell's own memory, out of reach of the session, so the
 * comparison stays where it is and the test comes to it: a stub `claude` on PATH rewrites a
 * file and answers in one line, and the assertion is the file `readSessionChanged` reads.
 *
 * The branch for a machine with no `shasum` is out of reach from here, because it would take
 * a PATH holding every other tool a run needs and not that one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACTION = join(import.meta.dir, "..");

/** The one line `extract-findings.ts` reads a run's cost and findings out of. */
const RESULT =
    '{"type":"result","subtype":"success","is_error":false,"duration_ms":1,"total_cost_usd":0.01,' +
    '"num_turns":1,"result":"{\\"summary\\":\\"s\\",\\"findings\\":[],\\"lens_health\\":[]}"}';

let root = "";
let workspace = "";
let runs = 0;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "codeferret-run-"));
    workspace = join(root, "repo");
    mkdirSync(workspace);

    const git = (...args: string[]): void => {
        const run = Bun.spawnSync(["git", "-c", "user.email=t@example.test", "-c", "user.name=t", ...args], {
            cwd: workspace,
        });

        if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(run.stderr)}`);
    };

    git("init", "--quiet", "--initial-branch", "main", ".");
    writeFileSync(join(workspace, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "first");
    git("branch", "base");
    writeFileSync(join(workspace, "a.txt"), "one\ntwo\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "second");
});

afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
});

/** One run directory, and what the run left in it. */
interface Run {
    /** The names `session-changed.txt` carries, in the order the script wrote them. */
    changed: string[];
    /** Everything the stub agent was started with, one `NAME=value` per line. */
    agentEnv: string;
}

/**
 * One review, with `mutate` standing in for whatever the session does to the run directory.
 *
 * The stub is the agent: `$BUILD` and `$SESSION` are the directories `run_dirs` makes,
 * and anything the shell writes to stdout would land in `run.json`, so the mutation writes
 * files and the last line is the result.
 */
function review(mutate: string, env: Record<string, string> = {}): Run {
    runs += 1;

    const out = join(root, `out-${runs}`);
    const bin = join(root, `bin-${runs}`);
    mkdirSync(bin, { recursive: true });

    const stub = join(bin, "claude");
    writeFileSync(
        stub,
        [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            'BUILD="$CF_OUT/build"',
            'SESSION="$CF_OUT/session"',
            'printenv >"$CF_OUT/agent-env.txt"',
            mutate,
            `printf '%s\\n' '${RESULT}'`,
            "",
        ].join("\n"),
    );
    chmodSync(stub, 0o755);

    Bun.spawnSync(["bash", join(ACTION, "review", "run.sh"), "base", ACTION, out, workspace], {
        env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: process.env.HOME ?? "",
            LENSES: "comment-review",
            CF_OUT: out,
            ...env,
        },
    });

    const file = join(out, "build", "session-changed.txt");
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";

    return {
        changed: text.split("\n").filter((line) => line !== ""),
        agentEnv: readFileSync(join(out, "agent-env.txt"), "utf8"),
    };
}

describe("run.sh: what the session changed under the run", () => {
    test("reports nothing when the session leaves the run directory alone", () => {
        expect(review(":").changed).toEqual([]);
    });

    test("reports a file the session rewrote in its own copy, which is a lens reading another diff", () => {
        expect(review('printf x >>"$SESSION/diff-args"').changed).toEqual(["diff-args"]);
    });

    test("reports a build file the session rewrote in both copies, which `cmp` alone would pass", () => {
        const { changed } = review('printf x >>"$BUILD/diff-args"; printf x >>"$SESSION/diff-args"');

        expect(changed).toEqual(["diff-args"]);
    });

    test("names a file once when it fails both comparisons", () => {
        // `diff-args` is in both lists, and the body used to read "changed diff-args,
        // diff-args under it" on the one line telling a reader how much to trust the rest.
        expect(review('printf x >>"$BUILD/diff-args"').changed).toEqual(["diff-args"]);
    });

    test("reports the lens list, which is what the coverage counts are drawn from", () => {
        expect(review('printf x >>"$BUILD/lenses.txt"').changed).toEqual(["lenses.txt"]);
    });

    test("reports each file it found, not the first", () => {
        const { changed } = review('printf x >>"$SESSION/diff.sh"; printf x >>"$BUILD/lenses.txt"');

        expect(changed).toEqual(["diff.sh", "lenses.txt"]);
    });

    test("truncates a file the session pre-created, so its own answer does not stand", () => {
        expect(review('printf \'a.ts\\n\' >"$BUILD/session-changed.txt"').changed).toEqual([]);
    });
});

describe("run.sh: what the agent is started with", () => {
    test("keeps a composite action's inputs out, including the ones `unset` cannot name", () => {
        const { agentEnv } = review(":", {
            "INPUT_GITHUB-TOKEN": "not-a-real-token",
            "INPUT_CLAUDE-CODE-OAUTH-TOKEN": "not-a-real-token",
            INPUT_MODEL: "opus",
        });

        expect(agentEnv).not.toContain("INPUT_");
        expect(agentEnv).not.toContain("not-a-real-token");
    });

    test("keeps out the tokens a caller's own job may have declared", () => {
        const { agentEnv } = review(":", { GITHUB_TOKEN: "not-a-real-token", ACTIONS_RUNTIME_TOKEN: "also-not-one" });

        expect(agentEnv).not.toContain("not-a-real-token");
        expect(agentEnv).not.toContain("also-not-one");
    });
});
