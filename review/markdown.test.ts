import { describe, expect, test } from "bun:test";
import { clamp, closeOpenDetails, closeOpenFence, escapeBlocks, escapeInline, fenceMap, prose } from "./markdown.ts";

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

    test("reads a marker indented four spaces as the indented code block the renderer does", () => {
        expect(fenceMap(["a", "    ```", "<div>"])).toEqual([false, false, false]);
    });

    test("reads a tab-indented marker the same way, a tab being four columns", () => {
        expect(fenceMap(["a", "\t```", "<div>"])).toEqual([false, false, false]);
    });

    test("still opens on the three spaces the renderer allows", () => {
        expect(fenceMap(["a", "   ```", "x"])).toEqual([false, true, true]);
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

    test("appends nothing for a marker the renderer reads as an indented code block", () => {
        const text = "see this:\n\n    ```\n\nend";

        expect(closeOpenFence(text)).toBe(text);
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

    test("leaves an escaped tag alone, which GitHub renders as the text it is", () => {
        const text = "a finding about \\<details> elements";

        expect(closeOpenDetails(text)).toBe(text);
    });

    test("leaves a tag inside a fenced sample alone, which renders as code", () => {
        const text = "```html\n<details>\n```";

        expect(closeOpenDetails(text)).toBe(text);
    });

    test("closes a block whose only closing tag is inside a code span", () => {
        const text = "<details>\n<summary>s</summary>\n\nthe `</details>` tag is what closes it";

        expect(closeOpenDetails(text)).toEndWith("closes it\n</details>");
    });

    test("appends nothing for a body that only names the element in a code span", () => {
        const text = "a body about the `<details>` element";

        expect(closeOpenDetails(text)).toBe(text);
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

    test("does not close a shorter opener on a longer run, which left a tag unescaped", () => {
        expect(escapeInline("``<details>``` a `")).toBe("\\`\\`\\<details>\\`\\`\\` a \\`");
    });

    test("closes a span on the next run of the opener's length, past the runs between", () => {
        expect(escapeInline("``x``` <img> ```y``")).toBe("``x``` <img> ```y``");
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

    test("escapes a markdown image, which renders without a click", () => {
        expect(escapeBlocks(["![alt](https://example.test/x.png)"])).toEqual(["\\![alt](https://example.test/x.png)"]);
    });

    test("leaves an ordinary exclamation mark and an ordinary link alone", () => {
        expect(escapeBlocks(["it fails! see [the docs](https://example.test)"])).toEqual([
            "it fails! see [the docs](https://example.test)",
        ]);
    });

    test("leaves an image inside a code span alone, which renders as code", () => {
        expect(escapeBlocks(["write `![alt](url)` for an image"])).toEqual(["write `![alt](url)` for an image"]);
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

describe("prose", () => {
    test("closes a fence the text left open, so the sections below it are not code", () => {
        expect(prose("Here is the risk:\n\n```ts\nconst x = 1;", 4000)).toEndWith("const x = 1;\n```");
    });

    test("closes with the delimiter the block was opened with", () => {
        expect(prose("~~~\nsample", 4000)).toEndWith("sample\n~~~");
    });

    test("adds no second closer on the cutting path, where clamp has already closed it", () => {
        const cut = prose("```\ncode line one\n\nmore\n\ntail", 22);

        expect(cut).toBe("```\ncode line one\n```\n\n_(cut for length)_");
    });

    test("leaves a balanced block alone", () => {
        const text = "before\n\n```sh\nx\n```\n\nafter";

        expect(prose(text, 4000)).toBe(text);
    });

    test("escapes a tag outside the fence and leaves the sample inside it alone", () => {
        expect(prose("wrap it in a <div>\n\n```html\n<div>\n```", 4000)).toBe(
            "wrap it in a \\<div>\n\n```html\n<div>\n```",
        );
    });
});
