// The rules over a parsed value, with no process to spawn and no log to match on.
// check-findings.test.ts covers the command around this: the exit codes and what it prints.

import { describe, expect, test } from "bun:test";
import { applyRules, readSchema, selfCheck } from "./finding-rules.ts";

const schema = await readSchema();

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

const check = (merged: Record<string, unknown>, dispatched: string[] = []) =>
    applyRules(schema, structuredClone(merged), dispatched);

describe("selfCheck", () => {
    test("every rule names a field the shipped schema has", () => {
        const rules = selfCheck(schema);

        expect(rules.stray).toEqual([]);
        expect(rules.enumsLost).toEqual([]);
        expect(rules.rules).toBeGreaterThan(0);
    });

    test("a schema with no severity enum leaves that repair unable to run", () => {
        expect(selfCheck({ type: "object", properties: {} }).enumsLost).toEqual(["status", "severity"]);
    });
});

describe("applyRules", () => {
    test("a file with nothing wrong is left alone", () => {
        const out = check({ findings: [finding()] });

        expect(out.changed).toBe(false);
        expect(out.dropped).toEqual([]);
        expect(out.kept).toBe(1);
    });

    test("a finding with no body is dropped and named, and the rest of the file survives", () => {
        const bare = finding({ title: "Nothing to render" });
        delete bare.body;

        const out = check({ findings: [bare, finding()] });

        expect(out.kept).toBe(1);
        expect(out.dropped[0]?.label).toContain("Nothing to render");
    });

    test("a lens claiming health as a string reads as needing attention", () => {
        const out = check({
            findings: [finding()],
            lens_health: [{ lens: "codeferret:a", findings_returned: 0, ok: "false" }],
        });

        const health = out.merged.lens_health as Array<{ ok?: unknown }>;

        expect(health[0]?.ok).toBe(false);
        expect(out.repairs.some((r) => r.includes("needing attention"))).toBe(true);
    });

    test("a dispatched lens with no health of its own is named", () => {
        const out = check(
            { findings: [finding()], lens_health: [{ lens: "codeferret:a", findings_returned: 1, ok: true }] },
            ["codeferret:a", "codeferret:b"],
        );

        expect(out.coverage[0]).toContain("b ran and reported no health");
    });

    test("a lens list and a health list spelled differently are the same lenses", () => {
        const out = check(
            { findings: [finding()], lens_health: [{ lens: "a", findings_returned: 1, ok: true }] },
            ["codeferret:a"],
        );

        expect(out.coverage).toEqual([]);
    });

    test("a `posted` record nothing has posted is removed", () => {
        const out = check({ findings: [finding()], posted: { at: "now", url: null, pr: "1" } });

        expect(out.merged.posted).toBeUndefined();
        expect(out.repairs[0]).toContain("posted");
    });
});
