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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "scrub-credentials.sh");
const HEADER = "http.https://github.com/.extraheader";
const VALUE = "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46bm90LWEtcmVhbC10b2tlbg==";

/**
 * `reachable` deliberately omits `--local`, so without these a global `http.*.extraheader` in
 * whoever is running the suite leaks into every assertion that nothing is reachable.
 */
const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ISOLATED } }).trim();
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

const TOKEN_URL = "https://x-access-token:not-a-real-token@github.com/owner/repo.git";
const CLEAN_URL = "https://github.com/owner/repo.git";

/**
 * The credential as a hand clone leaves it, which is what a caller running `checkout: skip` has
 * to do for themselves.
 *
 * `git remote add` rather than a `git config` of the key, because that is the spelling
 * `git clone` uses and the one whose result has to be scrubbed.
 */
function plantUrlCredential(dir: string): void {
    git(dir, "remote", "add", "origin", TOKEN_URL);
}

function url(dir: string, remote = "origin"): string {
    return git(dir, "remote", "get-url", remote);
}

function scrub(workspace: string): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync(["bash", SCRIPT, workspace], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...ISOLATED },
    });

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

    describe("the mechanism a hand clone uses", () => {
        test("rewrites a url carrying a token to its credential-free form", () => {
            const dir = repo();

            plantUrlCredential(dir);

            expect(scrub(dir).code).toBe(0);
            expect(url(dir)).toBe(CLEAN_URL);
        });

        test("does not report the workspace as clean over a token in a url", () => {
            const dir = repo();

            plantUrlCredential(dir);

            expect(scrub(dir).out).not.toContain("no git credential was reachable");
        });

        test("names the key without printing the credential, so a job log does not publish it", () => {
            const dir = repo();

            plantUrlCredential(dir);

            const proc = Bun.spawnSync(["bash", SCRIPT, "--check-one", dir], {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...process.env, ...ISOLATED },
            });
            const said = proc.stdout.toString();

            expect(said).toContain("remote.origin.url");
            expect(said).not.toContain("not-a-real-token");
        });

        test("keeps every url of a multi-valued remote, cleaning only the one that carried a token", () => {
            const dir = repo();

            plantUrlCredential(dir);
            git(dir, "config", "--local", "--add", "remote.origin.url", "https://mirror.example.com/owner/repo.git");

            expect(scrub(dir).code).toBe(0);
            expect(git(dir, "config", "--local", "--get-all", "remote.origin.url").split("\n")).toEqual([
                CLEAN_URL,
                "https://mirror.example.com/owner/repo.git",
            ]);
        });

        test("rewrites a submodule url in the superproject's config", () => {
            const dir = repo();

            // What `git submodule init` writes: the url a submodule is cloned from, copied
            // out of `.gitmodules` into the config git reads.
            git(dir, "config", "--local", "submodule.vendor.url", TOKEN_URL);

            expect(scrub(dir).code).toBe(0);
            expect(git(dir, "config", "--local", "submodule.vendor.url")).toBe(CLEAN_URL);
        });

        test("rewrites a url inside a submodule", () => {
            const dir = withSubmodule();

            git(join(dir, "vendor"), "remote", "set-url", "origin", TOKEN_URL);

            expect(scrub(dir).code).toBe(0);
            expect(url(join(dir, "vendor"))).toBe(CLEAN_URL);
        });

        test("leaves an ssh remote and a credential-free https remote alone", () => {
            const dir = repo();

            git(dir, "remote", "add", "origin", "git@github.com:owner/repo.git");
            git(dir, "remote", "add", "upstream", CLEAN_URL);

            expect(scrub(dir).code).toBe(0);
            expect(url(dir)).toBe("git@github.com:owner/repo.git");
            expect(url(dir, "upstream")).toBe(CLEAN_URL);
        });

        test("empties the reflog, which records the url a clone was given", () => {
            const dir = repo();

            plantUrlCredential(dir);

            expect(readFileSync(join(dir, ".git/logs/HEAD"), "utf8")).not.toBe("");

            scrub(dir);

            expect(readFileSync(join(dir, ".git/logs/HEAD"), "utf8")).toBe("");
        });

        test("removes FETCH_HEAD, which records the url a fetch used", () => {
            const dir = repo();
            const other = repo();

            plantUrlCredential(dir);
            git(dir, "fetch", "-q", other);

            expect(existsSync(join(dir, ".git/FETCH_HEAD"))).toBe(true);

            scrub(dir);

            expect(existsSync(join(dir, ".git/FETCH_HEAD"))).toBe(false);
        });

        test("leaves the reflog of a checkout whose urls carry no credential", () => {
            const dir = repo();

            plantHeader(dir);

            scrub(dir);

            expect(readFileSync(join(dir, ".git/logs/HEAD"), "utf8")).not.toBe("");
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

    // Each of these was a real defect in the first version of the script, found by reading it
    // rather than by any case above going red.
    describe("what it reports", () => {
        test("does not claim nothing was reachable when a submodule held a credential", () => {
            const dir = withSubmodule();

            plantHeader(join(dir, "vendor"));

            const r = scrub(dir);

            // `--one` runs in a child of the shell that reports, so a counter kept in a
            // variable stayed 0 here and the run said both that it had scrubbed a submodule
            // and that nothing had been reachable.
            expect(r.out).toContain("took the checkout's credential");
            expect(r.out).not.toContain("no git credential was reachable");
        });

        test("counts an includeIf key removed with its file already gone", () => {
            const dir = repo();

            git(dir, "config", "--local", `includeIf.gitdir:${join(dir, ".git")}.path`, "/nonexistent/creds.config");

            const r = scrub(dir);

            expect(r.code).toBe(0);
            expect(r.out).not.toContain("no git credential was reachable");
        });

        test("removes a credentials file named by a path relative to the config", () => {
            const dir = repo();
            const gitdir = git(dir, "rev-parse", "--absolute-git-dir");
            const cred = join(gitdir, "creds.config");

            git(dir, "config", "--file", cred, HEADER, VALUE);
            // Git resolves a relative include against the directory of the config file that
            // holds it. Testing the raw string with `[ -f ]` does not, so the key came off and
            // the file stayed.
            git(dir, "config", "--local", `includeIf.gitdir:${gitdir}.path`, "creds.config");

            expect(reachable(dir)).toContain("extraheader");

            expect(scrub(dir).code).toBe(0);
            expect(existsSync(cred)).toBe(false);
        });

        test("scrubs a submodule whose .gitmodules has been deleted", () => {
            const dir = withSubmodule();
            const cred = plantIncludeIf(join(dir, "vendor"));

            // `.gitmodules` is tracked in the branch under review, and `foreach --recursive`
            // walks the index rather than that file. Guarding the submodule pass on it let a
            // deletion take the scrub and its verification together.
            rmSync(join(dir, ".gitmodules"));

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
