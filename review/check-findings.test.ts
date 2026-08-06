// The exit codes are the contract: run.sh writes the marker the action posts on for 0 and
// 3, and not for 1.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "check-findings.ts");

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeferret-check-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        found_by: ["caveman-review"],
        file: "a.ts",
        line: 4,
        severity: "high",
        category: "correctness",
        title: "A title",
        body: "A body.",
        status: "new",
        ...over,
    };
}

async function check(merged: unknown): Promise<{ code: number; out: string; written: unknown }> {
    const path = join(dir, "findings.json");
    await Bun.write(path, JSON.stringify(merged, null, 2));

    const run = Bun.spawnSync(["bun", SCRIPT, path]);
    const decode = new TextDecoder();

    return {
        code: run.exitCode,
        out: `${decode.decode(run.stdout)}${decode.decode(run.stderr)}`,
        written: JSON.parse(await Bun.file(path).text()),
    };
}

/** The findings of a written-back file, whatever else it holds. */
function findingsOf(written: unknown): Array<Record<string, unknown>> {
    const list = (written as { findings?: unknown }).findings;
    return Array.isArray(list) ? list : [];
}

describe("check-findings", () => {
    test("passes a file with nothing wrong in it", async () => {
        const { code, out } = await check({ findings: [finding()] });

        expect(code).toBe(0);
        expect(out).toContain("shape valid");
    });

    test("keeps a finding with no line, which the body lists under its file alone", async () => {
        const finding_ = finding();
        delete finding_.line;

        const { code, out, written } = await check({ findings: [finding_] });

        expect(code).toBe(0);
        expect(out).toContain("WARN");
        expect(findingsOf(written)).toHaveLength(1);
    });

    test("says so when nothing reports what the lenses could not check", async () => {
        const { code, out } = await check({ findings: [finding()] });

        expect(code).toBe(0);
        expect(out).toContain("WARN lens_health: no entry");
    });

    test("names a dispatched lens that reported no health of its own", async () => {
        await Bun.write(join(dir, "lens-list.txt"), "- `codeferret:a`\n- `codeferret:b`\n");

        const { code, out } = await check({
            findings: [finding()],
            lens_health: [{ lens: "codeferret:a", findings_returned: 1, ok: true }],
        });

        expect(code).toBe(0);
        expect(out).toContain("codeferret:b ran and reported no health");
    });

    test("keeps a finding carrying a key nothing here knows about", async () => {
        const { code, written } = await check({ findings: [finding({ confidence: 0.8 })] });

        expect(code).toBe(0);
        expect(findingsOf(written)).toHaveLength(1);
    });

    test("keeps a finding whose severity is not one of ours", async () => {
        const { code, written } = await check({ findings: [finding({ severity: "Critical" })] });

        expect(code).toBe(0);
        expect(findingsOf(written)).toHaveLength(1);
    });

    test("repairs a status nothing downstream would read as a status", async () => {
        const { code, out, written } = await check({ findings: [finding({ status: "unsure" })] });

        expect(code).toBe(0);
        expect(out).toContain("FIXED");
        expect(findingsOf(written)[0]?.status).toBe("new");
    });

    test("repairs a path that is not repo-relative, so the next run matches it", async () => {
        const { code, written } = await check({ findings: [finding({ file: "/src/a.ts" })] });

        expect(code).toBe(0);
        expect(findingsOf(written)[0]?.file).toBe("src/a.ts");
    });

    test("removes a posted record, which only a posted review may write", async () => {
        const { code, out, written } = await check({ posted: { at: "2026-01-01" }, findings: [finding()] });

        expect(code).toBe(0);
        expect(out).toContain("FIXED posted");
        expect(written).not.toHaveProperty("posted");
    });

    test("drops a finding with nothing left to render and keeps the rest", async () => {
        const broken = finding({ title: "Doomed" });
        delete broken.body;

        const { code, out, written } = await check({ findings: [finding(), broken] });

        expect(code).toBe(3);
        expect(out).toContain("DROP");
        expect(findingsOf(written).map((f) => f.title)).toEqual(["A title"]);
    });

    test("fails outright when nothing usable is left", async () => {
        const broken = finding();
        delete broken.title;

        const { code, out } = await check({ findings: [broken] });

        expect(code).toBe(1);
        expect(out).toContain("nothing usable");
    });

    test("drops a lens_health entry that is not an object", async () => {
        const { code, written } = await check({ findings: [finding()], lens_health: ["broken"] });

        expect(code).toBe(3);
        expect((written as { lens_health?: unknown[] }).lens_health).toEqual([]);
    });

    test("keeps a severity that is only a spelling of a real one", async () => {
        const { code, out, written } = await check({ findings: [finding({ severity: " Critical " })] });

        expect(code).toBe(0);
        expect(out).toContain("FIXED");
        expect(findingsOf(written)[0]?.severity).toBe("critical");
    });

    test("drops a summary that is not prose, which post-review.ts would slice", async () => {
        const { code, out, written } = await check({ summary: 5, notes: [], findings: [finding()] });

        expect(code).toBe(0);
        expect(out).toContain("FIXED summary");
        expect(written).not.toHaveProperty("summary");
        expect(written).not.toHaveProperty("notes");
    });

    test("names a lens_health entry that names no lens, rather than dropping its caveat", async () => {
        const { code, out, written } = await check({
            findings: [finding()],
            lens_health: [{ lens: 7, findings_returned: 1, ok: true, detail: "no rendered page" }],
        });

        const health = (written as { lens_health?: Array<Record<string, unknown>> }).lens_health ?? [];

        expect(code).toBe(0);
        expect(out).toContain("FIXED");
        expect(health).toHaveLength(1);
        expect(health[0]?.lens).toBe("(unnamed lens)");
        expect(health[0]?.detail).toBe("no rendered page");
    });

    test("repairs a lens_health count the review would otherwise print as 'undefined'", async () => {
        const { code, out, written } = await check({
            findings: [finding()],
            lens_health: [{ lens: "codeferret:x", ok: true }],
        });

        const health = (written as { lens_health?: Array<Record<string, unknown>> }).lens_health ?? [];

        expect(code).toBe(0);
        expect(out).toContain("FIXED");
        expect(health[0]?.findings_returned).toBe(0);
    });

    test("drops a resolve entry whose reason post-review.ts would flatten", async () => {
        const { code, written } = await check({
            findings: [finding()],
            resolve: [{ thread_id: "a", reason: 9 }],
        });

        expect(code).toBe(3);
        expect((written as { resolve?: unknown[] }).resolve).toEqual([]);
    });

    test("takes a lens_health detail that is not prose off the entry, keeping the lens", async () => {
        const { code, out, written } = await check({
            findings: [finding()],
            lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true, detail: 12 }],
        });

        expect(code).toBe(0);
        expect(out).toContain("FIXED");
        expect((written as { lens_health?: Array<Record<string, unknown>> }).lens_health).toHaveLength(1);
        expect((written as { lens_health?: Array<Record<string, unknown>> }).lens_health?.[0]).not.toHaveProperty(
            "detail",
        );
    });

    test("removes a lens_health that is not a list, which would be a TypeError in post-review.ts", async () => {
        const { code, out, written } = await check({ findings: [finding()], lens_health: {} });

        expect(code).toBe(0);
        expect(out).toContain("FIXED lens_health");
        expect(written).not.toHaveProperty("lens_health");
    });

    test("removes a resolve that is not a list either", async () => {
        const { code, written } = await check({ findings: [finding()], resolve: "none" });

        expect(code).toBe(0);
        expect(written).not.toHaveProperty("resolve");
    });

    test("repairs a status that is missing, not only one that is wrong", async () => {
        const bare = finding();
        delete bare.status;

        const { code, written } = await check({ findings: [bare] });

        expect(code).toBe(0);
        expect(findingsOf(written)[0]?.status).toBe("new");
    });

    test("its own rules still name fields the schema has", async () => {
        const run = Bun.spawnSync(["bun", SCRIPT, "--self-check"]);

        expect(run.exitCode).toBe(0);
    });
});
