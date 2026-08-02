import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run the script rather than a function pulled out of it. The three exit codes are the
 * contract: run.sh writes the marker the action posts on for 0 and 3 and not for 1, and
 * both branch on nothing else. A pure function would leave that part untested, which is
 * the part a regression would be invisible in.
 */
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
    test("passes a file with nothing wrong with it", async () => {
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

    test("keeps a lens_health entry that is not an object out of the file", async () => {
        const { code, written } = await check({ findings: [finding()], lens_health: ["broken"] });

        expect(code).toBe(3);
        expect((written as { lens_health?: unknown[] }).lens_health).toEqual([]);
    });
});
