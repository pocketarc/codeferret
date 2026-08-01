import { describe, expect, test } from "bun:test";
import {
    anchorable,
    anchorableLines,
    assemble,
    bullet,
    clamp,
    escapeInline,
    MAX_BODY,
    rateLimitWait,
} from "./review-body.ts";
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

describe("anchorableLines", () => {
    test("counts context and added lines from the hunk's right-hand start", () => {
        const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +10,3 @@", " one", "+two", " three"].join("\n");

        expect([...(anchorableLines(diff).get("a.ts") ?? [])]).toEqual([10, 11, 12]);
    });

    test("skips removed lines", () => {
        const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,2 +1,1 @@", "-gone", " kept"].join("\n");

        expect([...(anchorableLines(diff).get("a.ts") ?? [])]).toEqual([1]);
    });

    test("a deleted file's /dev/null header does not leak lines onto the file before it", () => {
        const diff = [
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1,1 +1,1 @@",
            " one",
            "diff --git a/gone.ts b/gone.ts",
            "--- a/gone.ts",
            "+++ /dev/null",
            "@@ -1,3 +0,0 @@",
            "-x",
            "-y",
            "-z",
        ].join("\n");

        const byFile = anchorableLines(diff);

        expect([...(byFile.get("a.ts") ?? [])]).toEqual([1]);
        expect(byFile.has("/dev/null")).toBe(false);
    });

    test("an added line whose text begins with ++ is not read as a file header", () => {
        const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,2 @@", " one", "+++ still content"].join("\n");

        expect([...(anchorableLines(diff).get("a.ts") ?? [])]).toEqual([1, 2]);
    });
});

describe("anchorable", () => {
    const lines = new Set([10, 11, 12]);

    test("a finding with no line is not anchorable", () => {
        expect(anchorable(finding({ line: undefined as unknown as number }), lines)).toBe(false);
    });

    test("a file absent from the diff is not anchorable", () => {
        expect(anchorable(finding({ line: 10 }), undefined)).toBe(false);
    });

    test("every line of a range has to be in the diff", () => {
        expect(anchorable(finding({ line: 10, end_line: 12 }), lines)).toBe(true);
        expect(anchorable(finding({ line: 10, end_line: 13 }), lines)).toBe(false);
    });

    test("a reversed range is read in either order", () => {
        expect(anchorable(finding({ line: 12, end_line: 10 }), lines)).toBe(true);
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
});

describe("bullet", () => {
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
        const body = assemble([
            "## CodeFerret",
            { heading: "Findings", lead: "lead", items: [finding(), finding({ title: "Second" })] },
        ]);

        expect(body).toContain("## CodeFerret");
        expect(body).toContain("### Findings");
        expect(body).toContain("Second");
    });

    test("drops whole findings rather than cutting one, and says how many went", () => {
        const items = Array.from({ length: 200 }, (_, i) => finding({ title: `T${i}`, body: "x".repeat(2000) }));
        const body = assemble(["## CodeFerret", { heading: "Findings", lead: "lead", items }]);

        expect(body.length).toBeLessThanOrEqual(MAX_BODY);
        expect(body).toMatch(/further findings? left out for length/);
    });
});

describe("rateLimitWait", () => {
    test("is null for an ordinary rejection", () => {
        expect(rateLimitWait(422, null, "Validation Failed")).toBeNull();
    });

    test("honours retry-after on a 429", () => {
        expect(rateLimitWait(429, "120", "")).toBe(120_000);
    });

    test("recognises a secondary rate limit behind a 403", () => {
        expect(rateLimitWait(403, null, "You have exceeded a secondary rate limit")).toBe(60_000);
    });

    test("caps a retry-after nobody wants to wait out", () => {
        expect(rateLimitWait(429, "86400", "")).toBe(300_000);
    });
});
