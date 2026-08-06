import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDiffArgs, reviewedCommit } from "./diff-args.ts";

describe("reviewedCommit", () => {
    test("takes the commit build-prompts.sh pinned when the run started", () => {
        expect(reviewedCommit("origin/main...abc123")).toBe("abc123");
    });

    test("takes the last separator, so a base ref holding one does not win", () => {
        expect(reviewedCommit("origin/a...b...abc123")).toBe("abc123");
    });

    test("is null for a working-tree run, which has no commit to record against", () => {
        expect(reviewedCommit("origin/main")).toBeNull();
    });
});

describe("readDiffArgs", () => {
    test("splits the range from the pathspec git is given after it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "codeferret-args-"));
        const file = join(dir, "diff-args");

        await Bun.write(file, "origin/main...abc\0--\0:(top)\0:(top,exclude,glob)out/**\0");

        expect(await readDiffArgs(file)).toEqual({
            range: "origin/main...abc",
            pathspec: ["--", ":(top)", ":(top,exclude,glob)out/**"],
        });

        rmSync(dir, { recursive: true, force: true });
    });

    test("a run that excluded nothing has a range and no pathspec", async () => {
        const dir = mkdtempSync(join(tmpdir(), "codeferret-args-"));
        const file = join(dir, "diff-args");

        await Bun.write(file, "origin/main...abc\0");

        expect(await readDiffArgs(file)).toEqual({ range: "origin/main...abc", pathspec: [] });

        rmSync(dir, { recursive: true, force: true });
    });

    test("says which file is missing rather than reading an empty range", async () => {
        expect(readDiffArgs("/nowhere/diff-args")).rejects.toThrow("no /nowhere/diff-args");
    });

    test("an empty file names no range, which is not the same as a range of nothing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "codeferret-args-"));
        const file = join(dir, "diff-args");

        await Bun.write(file, "");

        expect(readDiffArgs(file)).rejects.toThrow("names no range");

        rmSync(dir, { recursive: true, force: true });
    });
});
