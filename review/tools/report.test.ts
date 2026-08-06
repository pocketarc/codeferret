import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argvBatches, keepRaised, MAX_ARGV_CHARS, MAX_FINDINGS } from "./report.ts";

describe("argvBatches", () => {
    test("keeps a short list in one spawn", () => {
        expect(argvBatches(["a.ts", "b.ts"])).toEqual([["a.ts", "b.ts"]]);
    });

    test("gives back nothing for nothing, so no empty spawn is made", () => {
        expect(argvBatches([])).toEqual([]);
    });

    test("splits before a batch reaches the kernel's argument limit", () => {
        const files = Array.from({ length: 200 }, (_, i) => `${"p".repeat(999)}/${i}.ts`);
        const batches = argvBatches(files);

        expect(batches.length).toBeGreaterThan(1);
        expect(batches.flat()).toEqual(files);

        for (const batch of batches) {
            expect(batch.join(" ").length).toBeLessThan(MAX_ARGV_CHARS);
        }
    });

    test("emits a path too long for any batch on its own rather than losing it", () => {
        const huge = "x".repeat(MAX_ARGV_CHARS * 2);

        expect(argvBatches(["a.ts", huge])).toEqual([["a.ts"], [huge]]);
    });
});

describe("keepRaised", () => {
    const raised = (n: number) => Array.from({ length: n }, (_, i) => ({ rule: `R${i}` }));

    test("writes nothing when the cap took nothing, so the report is the whole record", async () => {
        const dir = mkdtempSync(join(tmpdir(), "codeferret-raised-"));

        await keepRaised("semgrep", dir, raised(MAX_FINDINGS));

        expect(await Bun.file(join(dir, "raised-semgrep.json")).exists()).toBe(false);

        rmSync(dir, { recursive: true, force: true });
    });

    test("keeps the whole list past the cap, outside the glob the lens reads", async () => {
        const dir = mkdtempSync(join(tmpdir(), "codeferret-raised-"));

        await keepRaised("semgrep", dir, raised(MAX_FINDINGS + 1));

        const written = (await Bun.file(join(dir, "raised-semgrep.json")).json()) as { raised: unknown[] };

        expect(written.raised).toHaveLength(MAX_FINDINGS + 1);
        expect(await Array.fromAsync(new Bun.Glob("tool-*.json").scan({ cwd: dir }))).toEqual([]);

        rmSync(dir, { recursive: true, force: true });
    });
});
