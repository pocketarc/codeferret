import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "refuse-fork.sh");

const THIS_REPO = "pocketarc/codeferret";

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

    test("says so where head-sha names a commit and the event names no head repository", () => {
        const { code, stderr } = refuse({ EVENT: "workflow_dispatch", HEAD_SHA: "deadbeef" });

        expect(code).toBe(0);
        expect(stderr).toContain("head-sha names what this run reviews");
    });

    test("says so for pr-number, which decides which pull request is read and posted to", () => {
        const { code, stderr } = refuse({ EVENT: "issue_comment", PR_NUMBER: "12" });

        expect(code).toBe(0);
        expect(stderr).toContain("pr-number names what this run reviews");
    });

    test("says so for checkout: skip, where the caller's own step chose the tree", () => {
        const { code, stderr } = refuse({ EVENT: "issue_comment", CHECKOUT: "skip" });

        expect(code).toBe(0);
        expect(stderr).toContain("checkout: skip names what this run reviews");
    });

    test("names every route the caller took, not the first of them", () => {
        const { stderr } = refuse({ EVENT: "issue_comment", PR_NUMBER: "12", CHECKOUT: "skip" });

        expect(stderr).toContain("pr-number, checkout: skip");
    });

    test("says nothing where the event names no head repository and no input names a commit", () => {
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
