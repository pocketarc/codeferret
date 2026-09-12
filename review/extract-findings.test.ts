// What the command does with the answers, rather than what the answers are: the rules
// themselves are pure and are covered in run-log.test.ts. What is left to a spawn is that the
// run files are written at all, and written for the run that died.

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

async function extract(log: string): Promise<{ stderr: string }> {
    const runPath = join(dir, "run.json");
    await Bun.write(runPath, log);

    const spawned = Bun.spawnSync(["bun", SCRIPT, runPath, join(dir, "findings.json")]);

    return { stderr: new TextDecoder().decode(spawned.stderr) };
}

async function fileOf(name: string): Promise<string> {
    return Bun.file(join(dir, name)).text();
}

describe("extract-findings: the numbers a run leaves behind", () => {
    test("writes what the run cost where the log carries it", async () => {
        await extract(JSON.stringify([{ type: "result", total_cost_usd: 12.5, duration_ms: 60000 }]));

        expect(await fileOf("cost-usd")).toBe("12.50");
        expect(await fileOf("duration-ms")).toBe("60000");
    });

    test("writes every number for a session that produced no result at all", async () => {
        const { stderr } = await extract(JSON.stringify([{ type: "system" }]));

        expect(stderr).toContain("no result message in the run log");
        expect(await fileOf("findings-count")).toBe("none reported");
        expect(await fileOf("cost-usd")).toBe("unknown");
        expect(await fileOf("permission-denials")).toBe("unknown");
    });

    test("says why a run ended, from the fields a killed session carries", async () => {
        const { stderr } = await extract(
            JSON.stringify([
                {
                    type: "result",
                    is_error: true,
                    subtype: "success",
                    terminal_reason: "api_error",
                    api_error_status: 429,
                    result: "You've hit your session limit · resets 4am (UTC)",
                    total_cost_usd: 3.93,
                },
            ]),
        );

        expect(stderr).toContain("the run reported an error: api_error, HTTP 429");
        expect(stderr).toContain("You've hit your session limit");
    });

    test("survives a log cut off mid-line, which is the run whose cost matters most", async () => {
        const complete = JSON.stringify({ type: "result", total_cost_usd: 4.5 });

        const { stderr } = await extract(`{"type":"system"}\n${complete}\n{"type":"result","total_c`);

        expect(stderr).toContain("1 line(s) that are not JSON");
        expect(await fileOf("cost-usd")).toBe("4.50");
    });
});
