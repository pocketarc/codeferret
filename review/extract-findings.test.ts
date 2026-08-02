import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What a run cost, over the four shapes of run log that have been seen.
 *
 * A subscription-billed run reported `total_cost_usd` as zero while `modelUsage` said
 * otherwise, and zero is the number a reader takes for a free $36 review on every surface
 * it reaches. That fall-through is the behaviour pinned here.
 */
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

describe("extract-findings cost", () => {
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
});
