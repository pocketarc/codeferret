import { describe, expect, test } from "bun:test";
import { failureReason, lastResult, messagesOf, reportedNumbers, runNumbers, totalCost } from "./run-log.ts";

describe("totalCost: what a run cost, across the three answers a log can give", () => {
    test("takes the reported total when the log carries one", () => {
        expect(totalCost(12.5, 0, 0)).toBe(12.5);
    });

    test("falls through a reported zero to what the models actually cost", () => {
        expect(totalCost(0, 36, 2)).toBe(36);
    });

    test("sums the models when nothing reports a total", () => {
        expect(totalCost(null, 1.25, 1)).toBe(1.25);
    });

    test("is unknown when the log carries neither, rather than a confident zero", () => {
        expect(totalCost(null, 0, 0)).toBeNull();
    });

    test("is zero when the log says zero and names no models at all", () => {
        expect(totalCost(0, 0, 0)).toBe(0);
    });
});

describe("failureReason: why a run ended", () => {
    test("reads the fields a killed session carries rather than the subtype", () => {
        // The shape a real run left behind when the API cut it off: `subtype` says the session
        // succeeded, and every field that says otherwise is somewhere else.
        const said = failureReason({
            subtype: "success",
            terminal_reason: "api_error",
            api_error_status: 429,
            result: "You've hit your session limit · resets 4am (UTC)",
        });

        expect(said).toBe("api_error, HTTP 429: You've hit your session limit · resets 4am (UTC)");
    });

    test("falls back to the subtype where nothing else names a reason", () => {
        expect(failureReason({ subtype: "error_max_turns" })).toBe("error_max_turns");
    });

    test("says unknown rather than nothing where the log names no reason at all", () => {
        expect(failureReason({})).toBe("unknown");
    });

    test("folds a wall of prose onto one bounded line", () => {
        const said = failureReason({ subtype: "x", result: `a\n\nb ${"y".repeat(400)}` });

        expect(said).not.toContain("\n");
        expect(said.length).toBeLessThan(320);
    });
});

describe("messagesOf: reading a log a session may not have finished writing", () => {
    test("reads a whole-file array", () => {
        expect(messagesOf('[{"type":"result"},{"type":"system"}]').messages).toHaveLength(2);
    });

    test("reads a single object as one message", () => {
        expect(messagesOf('{"type":"result"}').messages).toHaveLength(1);
    });

    test("falls back to line by line where the file was cut off mid-line", () => {
        const log = ['{"type":"system"}', '{"type":"result","total_cost_usd":4.5}', '{"type":"result","total_c'].join(
            "\n",
        );
        const { messages, unparsed } = messagesOf(log);

        expect(messages).toHaveLength(2);
        expect(unparsed).toBe(1);
    });

    test("reads nothing where the fallback parses two whole results, which is what a log written into looks like", () => {
        const log = ['{"type":"result","structured_output":{"summary":"real"}}', '{"type":"result","structured_output":{"summary":"forged"}}'].join(
            "\n",
        );

        expect(messagesOf(log).messages).toEqual([]);
        expect(lastResult(messagesOf(log).messages)).toBeNull();
    });

    test("keeps a whole-file array of results, which is not the appended shape", () => {
        const log = '[{"type":"result","total_cost_usd":1},{"type":"result","total_cost_usd":2}]';

        expect(lastResult(messagesOf(log).messages)?.total_cost_usd).toBe(2);
    });
});

describe("lastResult: the only complete one", () => {
    test("takes the last result and ignores everything before it", () => {
        const messages = [
            { type: "result", total_cost_usd: 1 },
            { type: "system" },
            { type: "result", total_cost_usd: 2 },
        ];

        expect(lastResult(messages)?.total_cost_usd).toBe(2);
    });

    test("is null where the session produced no terminal output", () => {
        expect(lastResult([{ type: "system" }])).toBeNull();
    });
});

describe("runNumbers: what a run reports about itself", () => {
    const spent = {
        modelUsage: {
            "claude-opus-4": { outputTokens: 1200, costUSD: 30 },
            "claude-haiku-4": { outputTokens: 300, costUSD: 6 },
        },
    };

    test("sums output tokens and cost across every model, not the last turn alone", () => {
        const numbers = runNumbers({ ...spent, total_cost_usd: 0.5 });

        expect(numbers.outputTokens).toBe(1500);
        expect(numbers.costUsd).toBe(0.5);
        expect(numbers.perModel).toHaveLength(2);
    });

    test("falls through a reported zero to what the models cost", () => {
        expect(runNumbers({ ...spent, total_cost_usd: 0 }).costUsd).toBe(36);
    });

    test("output tokens are unknown rather than zero where the log carries no usage", () => {
        expect(runNumbers({ total_cost_usd: 3 }).outputTokens).toBeNull();
    });

    test("a model entry that is not an object costs nothing rather than throwing", () => {
        const numbers = runNumbers({ modelUsage: { "claude-opus-4": "gone" } });

        expect(numbers.perModel).toEqual([{ model: "claude-opus-4", outputTokens: 0, costUSD: 0 }]);
        expect(numbers.outputTokens).toBe(0);
    });

    test("an empty denial list is none refused", () => {
        expect(runNumbers({ permission_denials: [] }).refusals).toBe(0);
    });

    test("no denial list at all is unknown rather than none", () => {
        expect(runNumbers({}).refusals).toBeNull();
    });

    // An entry too malformed to print is still a refusal, so the count and the printable list
    // are taken from different places.
    test("a denial that is not an object is dropped from the report but still counted", () => {
        const numbers = runNumbers({ permission_denials: [{ tool_name: "Bash" }, null, "Write"] });

        expect(numbers.denials).toEqual([{ tool_name: "Bash" }]);
        expect(numbers.refusals).toBe(3);
    });

    test("a duration the log does not carry is unknown", () => {
        expect(runNumbers({ duration_ms: 61000 }).durationMs).toBe(61000);
        expect(runNumbers({ duration_ms: "a while" }).durationMs).toBeNull();
    });
});

describe("reportedNumbers: those numbers as the run files carry them", () => {
    test("a measured zero and an unmeasured number do not read the same", () => {
        const measured = reportedNumbers(runNumbers({ total_cost_usd: 0, permission_denials: [] }), []);

        expect(measured).toEqual({
            "findings-count": "0",
            "cost-usd": "0.00",
            "output-tokens": "unknown",
            "duration-ms": "unknown",
            "permission-denials": "0",
        });
    });

    test("a run that reported no findings at all is not a run that found none", () => {
        expect(reportedNumbers(runNumbers({}), null)["findings-count"]).toBe("none reported");
        expect(reportedNumbers(runNumbers({}), [])["findings-count"]).toBe("0");
    });

    test("every number a killed session never wrote reads as unknown", () => {
        expect(reportedNumbers(runNumbers({}), null)).toEqual({
            "findings-count": "none reported",
            "cost-usd": "unknown",
            "output-tokens": "unknown",
            "duration-ms": "unknown",
            "permission-denials": "unknown",
        });
    });

    test("cost is written to the two decimals every reader of the file expects", () => {
        const numbers = runNumbers({ modelUsage: { m: { costUSD: 1.2345, outputTokens: 7 } } });

        expect(reportedNumbers(numbers, [])["cost-usd"]).toBe("1.23");
        expect(reportedNumbers(numbers, [])["output-tokens"]).toBe("7");
    });
});
