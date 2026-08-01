import { describe, expect, test } from "bun:test";
import { assemble, bullet, clamp, escapeInline, MAX_BODY, mention, runUrl } from "./review-body.ts";
import type { Finding } from "./review-body.ts";

function finding(over: Partial<Finding> = {}): Finding {
    return {
        file: "a.ts",
        line: 1,
        severity: "low",
        category: "style",
        title: "A title",
        body: "A body.",
        ...over,
    };
}

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
});

describe("bullet", () => {
    test("opens with the position, so a reader can jump to it", () => {
        expect(bullet(finding({ line: 42 }))).toStartWith("- `a.ts:42` — **A title**");
    });

    test("escapes a heading a body line would otherwise open", () => {
        expect(bullet(finding({ body: "# not a heading" }))).toContain("\\# not a heading");
    });

    test("leaves a comment inside a fenced block alone", () => {
        const body = ["```sh", "# a shell comment", "```"].join("\n");

        expect(bullet(finding({ body }))).toContain("# a shell comment");
    });

    test("renders a range as a span", () => {
        expect(bullet(finding({ line: 4, end_line: 9 }))).toContain("`a.ts:4-9`");
    });

    test("names the file alone when the finding has no usable line", () => {
        expect(bullet(finding({ line: undefined as unknown as number }))).toStartWith("- `a.ts` —");
    });
});

describe("mention", () => {
    test("links the thread when there is one", () => {
        expect(mention(finding({ existing_comment_url: "https://example.test/1" }), "thread")).toBe(
            "- A title (`a.ts:1`) ([thread](https://example.test/1))",
        );
    });

    test("names the finding without a link when the previous run left no url", () => {
        expect(mention(finding(), "thread")).toBe("- A title (`a.ts:1`)");
    });
});

describe("runUrl", () => {
    test("builds the run url from what a runner sets", () => {
        expect(
            runUrl({
                GITHUB_SERVER_URL: "https://github.com",
                GITHUB_REPOSITORY: "pocketarc/codeferret",
                GITHUB_RUN_ID: "42",
            }),
        ).toBe("https://github.com/pocketarc/codeferret/actions/runs/42");
    });

    test("is null outside a run, so nothing links a page that does not exist", () => {
        expect(runUrl({ GITHUB_REPOSITORY: "pocketarc/codeferret" })).toBeNull();
    });
});

describe("clamp", () => {
    test("leaves prose under the limit alone", () => {
        expect(clamp("short", 100)).toBe("short");
    });

    test("cuts on a paragraph boundary", () => {
        expect(clamp("one\n\ntwo\n\nthree", 10)).toBe("one\n\ntwo\n\n_(cut for length)_");
    });

    test("closes a fence the cut left open", () => {
        const cut = clamp("```\ncode line one\n\nmore\n\ntail", 22);

        expect(cut.endsWith("```\n\n_(cut for length)_")).toBe(true);
    });
});

describe("assemble", () => {
    test("keeps the fixed sections and lists what fits", () => {
        const body = assemble(
            ["## CodeFerret"],
            { heading: "Findings", lead: "lead", items: [finding(), finding({ title: "Second" })] },
            ["### Caveats"],
        );

        expect(body).toContain("## CodeFerret");
        expect(body).toContain("### Findings");
        expect(body).toContain("Second");
        expect(body).toEndWith("### Caveats");
    });

    test("leaves the listing out when there is nothing to list", () => {
        expect(assemble(["## CodeFerret"], null, [])).toBe("## CodeFerret");
    });

    test("drops whole findings rather than cutting one, and says how many went", () => {
        const items = Array.from({ length: 200 }, (_, i) => finding({ title: `T${i}`, body: "x".repeat(2000) }));
        const body = assemble(["## CodeFerret"], { heading: "Findings", lead: "lead", items }, []);

        expect(body.length).toBeLessThanOrEqual(MAX_BODY);
        expect(body).toMatch(/further findings? left out for length/);
    });

    test("the tail survives a listing that would fill the body", () => {
        const items = Array.from({ length: 200 }, (_, i) => finding({ title: `T${i}`, body: "x".repeat(2000) }));
        const body = assemble(["## CodeFerret"], { heading: "Findings", lead: "lead", items }, ["### Caveats"]);

        expect(body).toEndWith("### Caveats");
    });
});
