import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "extract-findings.ts");

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeferret-extract-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

async function costOf(result: Record<string, unknown>): Promise<string> {
    const runPath = join(dir, "run.json");
    await Bun.write(runPath, JSON.stringify([{ type: "result", ...result }]));

    Bun.spawnSync(["bun", SCRIPT, runPath, join(dir, "findings.json")]);

    return Bun.file(join(dir, "cost-usd")).text();
}

describe("extract-findings: what a run cost, over the four shapes of run log seen so far", () => {
    test("takes the reported total when the log carries one", async () => {
        expect(await costOf({ total_cost_usd: 12.5 })).toBe("12.50");
    });

    test("falls through a reported zero to what the models actually cost", async () => {
        expect(
            await costOf({
                total_cost_usd: 0,
                modelUsage: { opus: { costUSD: 30 }, sonnet: { costUSD: 6 } },
            }),
        ).toBe("36.00");
    });

    test("sums the models when nothing reports a total", async () => {
        expect(await costOf({ modelUsage: { opus: { costUSD: 1.25 } } })).toBe("1.25");
    });

    test("is unknown when the log carries neither, rather than a confident zero", async () => {
        expect(await costOf({ subtype: "success" })).toBe("unknown");
    });

    test("is zero when the log says zero and names no models at all", async () => {
        expect(await costOf({ total_cost_usd: 0 })).toBe("0.00");
    });

    test("survives a log cut off mid-line, which is the run whose cost matters most", async () => {
        const runPath = join(dir, "run.json");
        const complete = JSON.stringify({ type: "result", total_cost_usd: 4.5 });

        await Bun.write(runPath, `{"type":"system"}\n${complete}\n{"type":"result","total_c`);

        Bun.spawnSync(["bun", SCRIPT, runPath, join(dir, "findings.json")]);

        expect(await Bun.file(join(dir, "cost-usd")).text()).toBe("4.50");
    });
});
