/**
 * What scrub-credentials.sh decides, as a table of cases.
 *
 * The script's correctness turns on something shellcheck cannot see: the read-back at the
 * end reads `git config --get-regexp`'s exit code as "a key is still set", the inverse of
 * how the same command is used as a loop source above it. Inverted, the step passes while
 * leaving the token in the tree every lens reads. So each case below plants a key and
 * asserts it is gone, rather than asserting the script ran.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "scrub-credentials.sh");
const KEY = "http.https://github.com/.extraheader";
const VALUE = "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46bm90LWEtcmVhbC10b2tlbg==";

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "scrub-"));

    git(dir, "init", "-q", ".");
    git(dir, "config", "user.email", "t@example.invalid");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    return dir;
}

/** A superproject with one submodule, the shape `actions/checkout` with `submodules` makes. */
function withSubmodule(): string {
    const inner = repo();
    const outer = repo();

    git(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor");
    git(outer, "commit", "-qm", "add submodule");

    return outer;
}

function scrub(workspace: string): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync(["bash", SCRIPT, workspace], { stdout: "pipe", stderr: "pipe" });

    return {
        code: proc.exitCode,
        out: proc.stdout.toString(),
        err: proc.stderr.toString(),
    };
}

function headers(cwd: string): string {
    try {
        return git(cwd, "config", "--local", "--get-regexp", "^http\\..*\\.extraheader$");
    } catch {
        return "";
    }
}

describe("scrub-credentials.sh", () => {
    test("removes the key actions/checkout leaves behind", () => {
        const dir = repo();

        git(dir, "config", "--local", KEY, VALUE);

        expect(scrub(dir).code).toBe(0);
        expect(headers(dir)).toBe("");
    });

    test("removes a key for a server that is not github.com", () => {
        const dir = repo();

        git(dir, "config", "--local", "http.https://ghe.example.com/.extraheader", VALUE);

        expect(scrub(dir).code).toBe(0);
        expect(headers(dir)).toBe("");
    });

    test("removes every value of a multi-valued key", () => {
        const dir = repo();

        git(dir, "config", "--local", KEY, VALUE);
        git(dir, "config", "--local", "--add", KEY, `${VALUE}2`);

        expect(scrub(dir).code).toBe(0);
        expect(headers(dir)).toBe("");
    });

    // The gap this file was written for. actions/checkout with `submodules` writes the same
    // key into each submodule's own config under .git/modules/<name>/config, which
    // `git config --local` in the superproject does not see. The step this replaced reported
    // success and left it there for any lens with Bash to read.
    test("removes the key from a submodule's own config", () => {
        const dir = withSubmodule();

        git(dir, "config", "--local", KEY, VALUE);
        git(join(dir, "vendor"), "config", "--local", KEY, VALUE);

        expect(scrub(dir).code).toBe(0);
        expect(headers(dir)).toBe("");
        expect(headers(join(dir, "vendor"))).toBe("");
    });

    test("removes a submodule's key when the superproject has none", () => {
        const dir = withSubmodule();

        git(join(dir, "vendor"), "config", "--local", KEY, VALUE);

        expect(scrub(dir).code).toBe(0);
        expect(headers(join(dir, "vendor"))).toBe("");
    });

    test("leaves unrelated http configuration alone", () => {
        const dir = repo();

        git(dir, "config", "--local", KEY, VALUE);
        git(dir, "config", "--local", "http.sslVerify", "true");

        expect(scrub(dir).code).toBe(0);
        expect(git(dir, "config", "--local", "http.sslVerify")).toBe("true");
    });

    test("is quiet and successful on a second run", () => {
        const dir = repo();

        git(dir, "config", "--local", KEY, VALUE);
        scrub(dir);

        const again = scrub(dir);

        expect(again.code).toBe(0);
        expect(again.out.trim()).toBe("");
    });

    test("says so and succeeds when there is no repository yet", () => {
        const dir = mkdtempSync(join(tmpdir(), "scrub-bare-"));
        const r = scrub(dir);

        expect(r.code).toBe(0);
        expect(r.err).toContain("nothing holds a credential yet");
    });

    test("fails rather than skipping when the workspace is not there", () => {
        expect(scrub(join(tmpdir(), "scrub-does-not-exist"))).toMatchObject({ code: 1 });
    });

    test("fails when given no workspace at all", () => {
        const proc = Bun.spawnSync(["bash", SCRIPT], { stdout: "pipe", stderr: "pipe" });

        expect(proc.exitCode).toBe(1);
        expect(proc.stderr.toString()).toContain("usage:");
    });
});
