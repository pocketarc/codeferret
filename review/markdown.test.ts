import { describe, expect, test } from "bun:test";
import { clamp, closeOpenDetails, closeOpenFence, escapeBlocks, escapeInline, fenceMap } from "./markdown.ts";

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

    test("does not close a block on a nested fence carrying an info string", () => {
        expect(fenceMap(["```", "```sql", "x", "```", "```"])).toEqual([true, true, true, true, true]);
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

describe("closeOpenDetails", () => {
    test("leaves a balanced block alone", () => {
        const text = "<details>\n<summary>s</summary>\n\nx\n</details>";

        expect(closeOpenDetails(text)).toBe(text);
    });

    test("closes one a cut left open", () => {
        expect(closeOpenDetails("<details open>\n<summary>s</summary>\n\nx")).toEndWith("x\n</details>");
    });

    test("closes one for each open block", () => {
        expect(closeOpenDetails("<details>\na\n</details>\n<details>\nb")).toEndWith("b\n</details>");
    });
});

describe("escapeInline", () => {
    test("leaves a code span alone", () => {
        expect(escapeInline("`**/out/**` is a glob")).toBe("`**/out/**` is a glob");
    });

    test("escapes emphasis outside a code span", () => {
        expect(escapeInline("**/out/** is a glob")).toBe("\\*\\*/out/\\*\\* is a glob");
    });

    test("escapes a link opener and raw html", () => {
        expect(escapeInline("a [b] <c>")).toBe("a \\[b\\] \\<c>");
    });

    test("escapes a backtick that opens no span, so it cannot pair with one below", () => {
        expect(escapeInline("the `foo parameter")).toBe("the \\`foo parameter");
    });

    test("escapes a backslash, which would otherwise cancel the escape after it", () => {
        expect(escapeInline("a\\*b")).toBe("a\\\\\\*b");
    });

    test("escapes a tilde pair, which renders as strikethrough", () => {
        expect(escapeInline("~~draft~~")).toBe("\\~\\~draft\\~\\~");
    });

    test("escapes an at sign, which would notify whoever owns that name", () => {
        expect(escapeInline("bump @types/bun")).toBe("bump \\@types/bun");
    });
});

describe("escapeBlocks", () => {
    test("escapes a tag wherever it sits on the line, not only at the start", () => {
        expect(escapeBlocks(["wrap it in a <div> instead"])).toEqual(["wrap it in a \\<div> instead"]);
    });

    test("leaves a tag inside a code span alone, so no backslash lands on the page", () => {
        expect(escapeBlocks(["the `<details>` element"])).toEqual(["the `<details>` element"]);
    });

    test("escapes a heading and a quote a line would open", () => {
        expect(escapeBlocks(["# heading", "  > quote"])).toEqual(["\\# heading", "  \\> quote"]);
    });

    test("escapes a setext underline, which turns the line above it into a heading", () => {
        expect(escapeBlocks(["A claim", "---"])).toEqual(["A claim", "\\---"]);
        expect(escapeBlocks(["A claim", "="])).toEqual(["A claim", "\\="]);
    });

    test("leaves the emphasis and links a model meant to write", () => {
        expect(escapeBlocks(["**bold** and [a link](https://example.test)"])).toEqual([
            "**bold** and [a link](https://example.test)",
        ]);
    });

    test("leaves everything inside a fence alone", () => {
        expect(escapeBlocks(["```html", "<div>", "```"])).toEqual(["```html", "<div>", "```"]);
    });

    test("escapes a mention in prose, which would notify an account on every push", () => {
        expect(escapeBlocks(["the @param tag"])).toEqual(["the \\@param tag"]);
    });
});

describe("clamp", () => {
    test("leaves text under the limit alone", () => {
        expect(clamp("short", 100)).toBe("short");
    });

    test("cuts on a paragraph boundary", () => {
        expect(clamp("one\n\ntwo\n\nthree", 10)).toBe("one\n\ntwo\n\n_(cut for length)_");
    });

    test("closes a fence the cut left open", () => {
        const cut = clamp("```\ncode line one\n\nmore\n\ntail", 22);

        expect(cut.endsWith("```\n\n_(cut for length)_")).toBe(true);
    });

    test("falls back to a sentence when one paragraph is all there is", () => {
        expect(clamp("One thing. Another thing. A third.", 20)).toBe("One thing.\n\n_(cut for length)_");
    });

    test("falls back to a word rather than cutting one in half", () => {
        expect(clamp("alpha beta gamma delta", 14)).toBe("alpha beta\n\n_(cut for length)_");
    });
});
