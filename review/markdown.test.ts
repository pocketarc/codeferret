import { describe, expect, test } from "bun:test";
import { closeOpenFence, fenceMap } from "./markdown.ts";

describe("fenceMap", () => {
    test("marks the delimiters as fenced, so a caller mapping the rest leaves them alone", () => {
        expect(fenceMap(["a", "```", "b", "```", "c"])).toEqual([false, true, true, true, false]);
    });

    test("keeps a shorter run inside a longer fence, which is how a block nests", () => {
        const lines = ["````", "```sh", "x", "```", "````", "after"];

        expect(fenceMap(lines)).toEqual([true, true, true, true, true, false]);
    });

    test("does not close a backtick fence with tildes", () => {
        expect(fenceMap(["```", "~~~", "still code"])).toEqual([true, true, true]);
    });

    test("reads everything after an unclosed fence as code", () => {
        expect(fenceMap(["```", "x"])).toEqual([true, true]);
    });
});

describe("closeOpenFence", () => {
    test("leaves a balanced block alone", () => {
        expect(closeOpenFence("```\nx\n```")).toBe("```\nx\n```");
    });

    test("closes with the delimiter the block was opened with", () => {
        expect(closeOpenFence("````\n```\nx\n```")).toBe("````\n```\nx\n```\n````");
    });

    test("agrees with fenceMap about a nested block that is closed", () => {
        const text = "````\n```\nx\n```\n````";

        expect(closeOpenFence(text)).toBe(text);
        expect(fenceMap(text.split("\n")).every(Boolean)).toBe(true);
    });
});
