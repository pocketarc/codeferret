import { describe, expect, test } from "bun:test";
import { codexArgs, codexResult, concurrent, renderTemplate, replaceOnce, strictSchema, withoutNullProperties } from "./codex.ts";
import { reportedNumbers, runNumbers } from "./run-log.ts";
import { record } from "./json.ts";

function log(output: unknown, usage: unknown = { output_tokens: 23 }): string {
    return [
        { type: "thread.started", thread_id: "test" },
        { type: "turn.started" },
        { type: "item.completed", item: { type: "agent_message", text: "Checking the diff." } },
        { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } },
        { type: "turn.completed", usage },
    ].map((event) => JSON.stringify(event)).join("\n");
}

describe("Codex event output", () => {
    test("reads the final response and removes nullable optional properties", () => {
        expect(codexResult(log({ findings: [{ title: "t", end_line: null }], notes: null }), 0)).toEqual({
            output: { findings: [{ title: "t" }] }, outputTokens: 23, error: null,
        });
    });

    test("rejects incomplete turns, failed processes and appended events", () => {
        const complete = log({ findings: [] });
        const failures = [
            complete.slice(0, complete.lastIndexOf("\n")),
            `${complete}\n{`,
            `${complete}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"findings":[]}' } })}`,
            `${complete}\n${complete}`,
            log({ findings: "none" }),
            complete.replace('"turn.completed"', '"turn.failed"'),
        ];
        for (const failed of failures) expect(codexResult(failed, 0).output).toBeNull();
        expect(codexResult(complete, 1).output).toBeNull();
    });

    test("preserves unknown usage and cost", () => {
        for (const usage of [null, {}, { output_tokens: -1 }, { output_tokens: "23" }]) {
            expect(codexResult(log({ findings: [] }, usage), 0).outputTokens).toBeNull();
        }
        const numbers = runNumbers({ engine: "codex", usage: { output_tokens: 46 }, duration_ms: 100 });
        expect(reportedNumbers(numbers, [])).toMatchObject({
            "output-tokens": "46", "cost-usd": "unknown", "permission-denials": "unknown", "duration-ms": "100",
        });
    });
});

describe("Codex schemas", () => {
    test("makes optional fields nullable at every object depth", () => {
        const source = { type: "object", required: ["items"], properties: {
            notes: { type: "string" },
            items: { type: "array", items: { type: "object", properties: { line: { type: "integer" } } } },
        } };
        const schema = record(strictSchema(source));
        expect(schema?.required).toEqual(["notes", "items"]);
        const properties = record(schema?.properties);
        expect(properties?.notes).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
        const nested = record(record(properties?.items)?.items);
        expect(nested?.required).toEqual(["line"]);
        expect(nested?.additionalProperties).toBe(false);
        expect(source.required).toEqual(["items"]);
        expect(withoutNullProperties({ optional: null, zero: 0, flag: false, text: "" })).toEqual({ zero: 0, flag: false, text: "" });
    });
});

test("keeps model and paths as separate arguments and sets read-only permissions", () => {
    const args = codexArgs("/tmp/a b", "/tmp/schema.json", "model;literal", "high");
    expect(args).toContain("/tmp/a b");
    expect(args).toContain("model;literal");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("project_doc_max_bytes=0");
    expect(args).toContain('web_search="disabled"');
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
});

test("limits parallel work and retains dispatch order", async () => {
    let active = 0;
    let peak = 0;
    const result = await concurrent([30, 20, 10, 1], 2, async (delay) => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(delay);
        active -= 1;
        return delay;
    });
    expect(result).toEqual([30, 20, 10, 1]);
    expect(peak).toBe(2);
});

test("replaces each template placeholder once", () => {
    expect(renderTemplate("before __FIRST__ after __SECOND__", {
        __FIRST__: "__SECOND__",
        __SECOND__: "done",
    })).toBe("before __SECOND__ after done");
});

test("replaces only the template reports marker", () => {
    expect(replaceOnce("/repo/__WORK__/orchestrator CODEFERRET_LENS_REPORTS", "CODEFERRET_LENS_REPORTS", "reports"))
        .toBe("/repo/__WORK__/orchestrator reports");
});
