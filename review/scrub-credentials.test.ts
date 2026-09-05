/**
 * What scrub-credentials.sh decides, as a table of cases.
 *
 * The fixture is the whole of it. An earlier version of this file planted
 * `http.<server>.extraheader` in `.git/config` by hand and read it back with `--local`, and
 * passed every case while the script it tested was a no-op against a real checkout:
 * `actions/checkout` writes the header into a file under `$RUNNER_TEMP` and links it with
 * `includeIf.gitdir`, and `git config --local` does not expand an include. So each case here
 * builds the config the way checkout builds it, and `reachable` reads it back the way a lens
 * would.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "scrub-credentials.sh");
const HEADER = "http.https://github.com/.extraheader";
const VALUE = "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46bm90LWEtcmVhbC10b2tlbg==";

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * `realpathSync` because `includeIf gitdir:` matches the resolved path, and on macOS
 * `mkdtemp` hands back `/var/folders/...`, a symlink to `/private/var/folders/...`. An
 * include written against the unresolved form never applies, and the case then passes
 * whatever the script does.
 */
function repo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "scrub-")));

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

/** The credential as `actions/checkout@v6` leaves it. */
function plantIncludeIf(dir: string): string {
    const cred = join(realpathSync(mkdtempSync(join(tmpdir(), "runner-temp-"))), "git-credentials-abc123.config");

    // In a submodule `<dir>/.git` is a gitfile and the git directory is
    // `<superproject>/.git/modules/<name>`, so a condition written against the working tree
    // never matches and the case tests nothing.
    const gitdir = git(dir, "rev-parse", "--absolute-git-dir");

    git(dir, "config", "--file", cred, HEADER, VALUE);
    git(dir, "config", "--local", `includeIf.gitdir:${gitdir}.path`, cred);

    return cred;
}

/** The header as an older checkout leaves it, in the repository's own config. */
function plantHeader(dir: string, key = HEADER): void {
    git(dir, "config", "--local", key, VALUE);
}

function scrub(workspace: string): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync(["bash", SCRIPT, workspace], { stdout: "pipe", stderr: "pipe" });

    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

/** What a lens with `Bash` would get: no `--local`, so an include is expanded. */
function reachable(cwd: string): string {
    try {
        return git(cwd, "config", "--get-regexp", "^http\\..*\\.extraheader$");
    } catch {
        return "";
    }
}

describe("scrub-credentials.sh", () => {
    describe("the mechanism actions/checkout@v6 uses", () => {
        test("removes a credential reachable only through includeIf", () => {
            const dir = repo();

            plantIncludeIf(dir);

            expect(reachable(dir)).toContain("extraheader");

            expect(scrub(dir).code).toBe(0);
            expect(reachable(dir)).toBe("");
        });

        test("deletes the credentials file rather than only dereferencing it", () => {
            const dir = repo();
            const cred = plantIncludeIf(dir);

            expect(existsSync(cred)).toBe(true);

            scrub(dir);

            expect(existsSync(cred)).toBe(false);
        });

        test("removes the includeIf key as well as the file", () => {
            const dir = repo();

            plantIncludeIf(dir);
            scrub(dir);

            expect(() => git(dir, "config", "--local", "--name-only", "--get-regexp", "^includeif\\..*\\.path$")).toThrow();
        });

        test("says what it did, so silence cannot pass for success", () => {
            const dir = repo();

            plantIncludeIf(dir);

            expect(scrub(dir).out).toContain("took the checkout's credential");
        });

        test("tolerates an includeIf whose file is not there", () => {
            const dir = repo();

            git(dir, "config", "--local", `includeIf.gitdir:${join(dir, ".git")}.path`, "/nonexistent/creds.config");

            expect(scrub(dir).code).toBe(0);
        });
    });

    describe("the mechanism an older checkout uses", () => {
        test("removes a header in the repository's own config", () => {
            const dir = repo();

            plantHeader(dir);

            expect(scrub(dir).code).toBe(0);
            expect(reachable(dir)).toBe("");
        });

        test("removes a header for a server that is not github.com", () => {
            const dir = repo();

            plantHeader(dir, "http.https://ghe.example.com/.extraheader");

            expect(scrub(dir).code).toBe(0);
            expect(reachable(dir)).toBe("");
        });

        test("removes every value of a multi-valued key", () => {
            const dir = repo();

            plantHeader(dir);
            git(dir, "config", "--local", "--add", HEADER, `${VALUE}2`);

            expect(scrub(dir).code).toBe(0);
            expect(reachable(dir)).toBe("");
        });

        test("removes both mechanisms when both are present", () => {
            const dir = repo();

            plantHeader(dir);
            const cred = plantIncludeIf(dir);

            expect(scrub(dir).code).toBe(0);
            expect(reachable(dir)).toBe("");
            expect(existsSync(cred)).toBe(false);
        });
    });

    describe("submodules", () => {
        test("removes a header from a submodule's own config", () => {
            const dir = withSubmodule();

            plantHeader(dir);
            plantHeader(join(dir, "vendor"));

            expect(scrub(dir).code).toBe(0);
            expect(reachable(dir)).toBe("");
            expect(reachable(join(dir, "vendor"))).toBe("");
        });

        test("removes an includeIf credential from a submodule", () => {
            const dir = withSubmodule();
            const cred = plantIncludeIf(join(dir, "vendor"));

            expect(reachable(join(dir, "vendor"))).toContain("extraheader");

            expect(scrub(dir).code).toBe(0);
            expect(reachable(join(dir, "vendor"))).toBe("");
            expect(existsSync(cred)).toBe(false);
        });
    });

    describe("what it refuses", () => {
        test("leaves unrelated http configuration alone", () => {
            const dir = repo();

            plantHeader(dir);
            git(dir, "config", "--local", "http.sslVerify", "true");

            expect(scrub(dir).code).toBe(0);
            expect(git(dir, "config", "--local", "http.sslVerify")).toBe("true");
        });

        test("says so and succeeds when there is no repository yet", () => {
            const r = scrub(realpathSync(mkdtempSync(join(tmpdir(), "scrub-bare-"))));

            expect(r.code).toBe(0);
            expect(r.err).toContain("nothing holds a credential yet");
        });

        test("fails rather than skipping when the workspace is not there", () => {
            expect(scrub(join(tmpdir(), "scrub-does-not-exist")).code).toBe(1);
        });

        test("fails when given no workspace at all", () => {
            const proc = Bun.spawnSync(["bash", SCRIPT], { stdout: "pipe", stderr: "pipe" });

            expect(proc.exitCode).toBe(1);
            expect(proc.stderr.toString()).toContain("usage:");
        });

        test("reports a clean checkout rather than saying nothing", () => {
            const r = scrub(repo());

            expect(r.code).toBe(0);
            expect(r.out).toContain("no git credential was reachable");
        });
    });
});
