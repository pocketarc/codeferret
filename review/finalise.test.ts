/**
 * The case table. `run.test.ts` runs the whole of run.sh and covers the guard where a session
 * can reach it; what is here is every entry a sweep removes and every combination of the
 * session, extraction and shape-check exits.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardBuildDir, settle, UNREPORTED } from "./finalise.ts";
import { RUN_FILES } from "./run-files.ts";

let dir = "";

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeferret-finalise-"));
});

afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("guardBuildDir: what a run will still read after the session", () => {
    test("leaves a plain file alone", () => {
        writeFileSync(join(dir, "run.json"), "{}");

        expect(guardBuildDir(dir)).toEqual([]);
        expect(existsSync(join(dir, "run.json"))).toBe(true);
    });

    test("removes a link to a file the runner user can read, which upload-artifact would follow", () => {
        const target = join(dir, "..", "target.txt");
        writeFileSync(target, "secret\n");
        symlinkSync(target, join(dir, RUN_FILES.cost));

        expect(guardBuildDir(dir)).toEqual([RUN_FILES.cost]);
        expect(existsSync(join(dir, RUN_FILES.cost))).toBe(false);

        rmSync(target, { force: true });
    });

    test("removes a link even where it points at a plain file inside the directory", () => {
        writeFileSync(join(dir, "findings.json"), "{}");
        symlinkSync(join(dir, "findings.json"), join(dir, RUN_FILES.findingsChecked));

        expect(guardBuildDir(dir)).toEqual([RUN_FILES.findingsChecked]);
        expect(existsSync(join(dir, "findings.json"))).toBe(true);
    });

    test("removes a dangling link, which a check of its target would pass", () => {
        symlinkSync(join(dir, "nothing-here"), join(dir, "lens-list.txt"));

        expect(guardBuildDir(dir)).toEqual(["lens-list.txt"]);
    });

    test("removes a directory the session left where a file belongs", () => {
        mkdirSync(join(dir, RUN_FILES.permissionDenials));
        writeFileSync(join(dir, RUN_FILES.permissionDenials, "inside.txt"), "x");

        expect(guardBuildDir(dir)).toEqual([RUN_FILES.permissionDenials]);
        expect(existsSync(join(dir, RUN_FILES.permissionDenials))).toBe(false);
    });

    test("names every entry it removed, not the first", () => {
        writeFileSync(join(dir, "run.json"), "{}");
        symlinkSync("/etc/hosts", join(dir, "lenses.txt"));
        symlinkSync("/etc/hosts", join(dir, RUN_FILES.durationMs));

        expect(guardBuildDir(dir)).toEqual([RUN_FILES.durationMs, "lenses.txt"]);
        expect(existsSync(join(dir, "run.json"))).toBe(true);
    });
});

describe("UNREPORTED: the numbers a run that reported none still writes", () => {
    test("covers every run file but the marker the action posts on", () => {
        const named = Object.values(RUN_FILES).filter((file) => file !== RUN_FILES.findingsChecked);

        expect(Object.keys(UNREPORTED).sort()).toEqual([...named].sort());
    });
});

describe("settle: what a run ends on", () => {
    test("posts and ends green where the session, the extraction and the shape check all went through", () => {
        expect(settle(0, 0, 0)).toEqual({ status: 0, postable: true, reasons: [] });
    });

    test("posts and ends red where the shape check repaired what it could", () => {
        expect(settle(0, 0, 3)).toMatchObject({ status: 1, postable: true });
    });

    test("keeps a failed session's status over a clean extraction", () => {
        expect(settle(1, 0, 0)).toMatchObject({ status: 1, postable: true });
    });

    test("takes the extraction's status where the session ended clean", () => {
        expect(settle(0, 1, null)).toMatchObject({ status: 1, postable: false });
    });

    test("ends red where the shape check refused the file outright", () => {
        expect(settle(0, 0, 1)).toMatchObject({ status: 1, postable: false });
    });

    test("ends red and says so where there was no run log at all", () => {
        const settled = settle(0, null, null);

        expect(settled.status).not.toBe(0);
        expect(settled.postable).toBe(false);
        expect(settled.reasons.join(" ")).toContain("no run log");
    });

    test("keeps a failed session's own status where there was no run log either", () => {
        expect(settle(2, null, null)).toMatchObject({ status: 2, postable: false });
    });

    test("puts down no marker for a findings file no extraction produced", () => {
        // With no run log there was no extraction, so a shape-valid findings file beside it is
        // one the session wrote. The marker is the whole of what the action posts on.
        expect(settle(0, null, 0)).toMatchObject({ postable: false });
        expect(settle(0, null, 3)).toMatchObject({ postable: false });
    });
});
