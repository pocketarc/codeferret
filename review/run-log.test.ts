import { describe, expect, test } from "bun:test";
import { failureReason, lastResult, messagesOf, totalCost } from "./run-log.ts";

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
