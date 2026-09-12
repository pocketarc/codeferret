import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "refuse-fork.sh");

const THIS_REPO = "pocketarc/codeferret";

let root = "";
let checkedOut = "";
let empty = "";

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "codeferret-fork-"));
    checkedOut = join(root, "checked-out");
    empty = join(root, "empty");
    mkdirSync(join(checkedOut, ".git"), { recursive: true });
    mkdirSync(empty);
});

afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
});

/** One row of the decision table, run as the action runs it. */
function refuse(env: Record<string, string>): { code: number; stderr: string } {
    const run = Bun.spawnSync(["bash", SCRIPT], {
        env: { PATH: process.env.PATH ?? "", THIS_REPO, ...env },
    });

    return { code: run.exitCode, stderr: new TextDecoder().decode(run.stderr) };
}

describe("refuse-fork: whose commit this run may review", () => {
    test("refuses pull_request_target whatever the payload names", () => {
        const { code, stderr } = refuse({ EVENT: "pull_request_target", HEAD_REPO: THIS_REPO });

        expect(code).toBe(1);
        expect(stderr).toContain("will not run under pull_request_target");
    });

    test("refuses a pull request whose head is on another repository", () => {
        const { code, stderr } = refuse({ EVENT: "pull_request", HEAD_REPO: "someone/codeferret" });

        expect(code).toBe(1);
        expect(stderr).toContain("someone/codeferret");
    });

    test("refuses a workflow_run whose head repository is another one", () => {
        const { code, stderr } = refuse({ EVENT: "workflow_run", RUN_REPO: "someone/codeferret" });

        expect(code).toBe(1);
        expect(stderr).toContain("someone/codeferret");
    });

    test("passes a pull request from a branch of this repository, in silence", () => {
        const { code, stderr } = refuse({ EVENT: "pull_request", HEAD_REPO: THIS_REPO, PR_NUMBER: "12" });

        expect(code).toBe(0);
        expect(stderr).toBe("");
    });

    test("refuses where head-sha names a commit and the event names no head repository", () => {
        const { code, stderr } = refuse({ EVENT: "workflow_dispatch", HEAD_SHA: "deadbeef" });

        expect(code).toBe(1);
        expect(stderr).toContain("head-sha names what this run reviews");
    });

    test("refuses for pr-number, which decides which pull request is read and posted to", () => {
        const { code, stderr } = refuse({ EVENT: "issue_comment", PR_NUMBER: "12" });

        expect(code).toBe(1);
        expect(stderr).toContain("pr-number names what this run reviews");
    });

    test("refuses for checkout: skip, where the caller's own step chose the tree", () => {
        const { code, stderr } = refuse({ EVENT: "issue_comment", CHECKOUT: "skip" });

        expect(code).toBe(1);
        expect(stderr).toContain("checkout: skip names what this run reviews");
    });

    test("refuses for a checkout the caller left in the workspace with every input at its default", () => {
        const { code, stderr } = refuse({ EVENT: "issue_comment", WORKSPACE: checkedOut });

        expect(code).toBe(1);
        expect(stderr).toContain("a checkout this action did not make names what this run reviews");
    });

    test("passes an empty workspace, where nothing has chosen a tree yet", () => {
        const { code, stderr } = refuse({ EVENT: "issue_comment", WORKSPACE: empty });

        expect(code).toBe(0);
        expect(stderr).toBe("");
    });

    test("names every route the caller took, not the first of them", () => {
        const { stderr } = refuse({ EVENT: "issue_comment", PR_NUMBER: "12", CHECKOUT: "skip" });

        expect(stderr).toContain("pr-number, checkout: skip");
    });

    test("proceeds with the reason on stderr where unverified-head says the job is restricted already", () => {
        const { code, stderr } = refuse({ EVENT: "issue_comment", PR_NUMBER: "12", UNVERIFIED_HEAD: "allow" });

        expect(code).toBe(0);
        expect(stderr).toContain("pr-number names what this run reviews");
        expect(stderr).toContain("the job's if: is the only gate");
    });

    test("refuses a value for unverified-head that is neither 'refuse' nor 'allow', on any event", () => {
        const { code, stderr } = refuse({ EVENT: "pull_request", HEAD_REPO: THIS_REPO, UNVERIFIED_HEAD: "yes" });

        expect(code).toBe(1);
        expect(stderr).toContain("unverified-head is 'yes'");
    });

    test("says nothing where the event names no head repository and nothing names a commit", () => {
        const { code, stderr } = refuse({ EVENT: "schedule" });

        expect(code).toBe(0);
        expect(stderr).toBe("");
    });

    test("says nothing about the inputs on a pull request, where the head repository decides", () => {
        const { code, stderr } = refuse({
            EVENT: "pull_request",
            HEAD_REPO: THIS_REPO,
            HEAD_SHA: "deadbeef",
            CHECKOUT: "skip",
        });

        expect(code).toBe(0);
        expect(stderr).toBe("");
    });
});
