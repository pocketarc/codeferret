import { describe, expect, test } from "bun:test";
import {
    assemble,
    bullet,
    clamp,
    composeReview,
    escapeInline,
    MAX_BODY,
    mention,
    partition,
    runUrl,
} from "./review-body.ts";
import type { Finding, Merged, Outcome } from "./review-body.ts";

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

    test("escapes a backtick that opens no span, so it cannot pair with one below", () => {
        expect(escapeInline("the `foo parameter")).toBe("the \\`foo parameter");
    });

    test("escapes a backslash, which would otherwise cancel the escape after it", () => {
        expect(escapeInline("a\\*b")).toBe("a\\\\\\*b");
    });

    test("escapes a trailing backslash, which would eat the closing emphasis", () => {
        expect(bullet(finding({ title: "windows\\path\\" }))).toContain("**windows\\\\path\\\\**");
    });

    test("escapes a tilde pair, which renders as strikethrough", () => {
        expect(escapeInline("~~draft~~")).toBe("\\~\\~draft\\~\\~");
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

    test("closes a fence the body left open, so the rest of the review is not code", () => {
        expect(bullet(finding({ body: "```sh\nx" }))).toContain("```sh\n  x\n  ```");
    });

    test("leaves the category line out when the finding has none", () => {
        expect(bullet(finding({ category: "" }))).not.toContain("undefined");
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

describe("partition", () => {
    test("splits on status and orders by severity", () => {
        const { all, fresh, suppressed, declined } = partition([
            finding({ title: "low", severity: "low" }),
            finding({ title: "seen", status: "already-reported" }),
            finding({ title: "crit", severity: "critical" }),
            finding({ title: "no", status: "declined" }),
        ]);

        expect(all.map((f) => f.title)).toEqual(["crit", "low", "seen", "no"]);
        expect(fresh.map((f) => f.title)).toEqual(["crit", "low"]);
        expect(suppressed.map((f) => f.title)).toEqual(["seen"]);
        expect(declined.map((f) => f.title)).toEqual(["no"]);
    });
});

describe("composeReview", () => {
    const quiet: Outcome = { resolved: [], resolveDenied: false, leftOpen: 0, env: {} };

    function review(over: Partial<Merged> = {}, outcome: Partial<Outcome> = {}): string {
        return composeReview({ findings: [], ...over }, { ...quiet, ...outcome });
    }

    test("titles the listing for the severities it carries", () => {
        expect(review({ findings: [finding({ severity: "high" })] })).toContain("### Critical and high findings");
        expect(review({ findings: [finding({ severity: "low" })] })).toContain("### Findings");
    });

    test("announces a lens that did not report, above the collapsed list", () => {
        const body = review({
            lens_health: [
                { lens: "codeferret:caveman-review", findings_returned: 0, ok: false, detail: "no output" },
                { lens: "codeferret:writing-review", findings_returned: 3, ok: true },
            ],
        });

        expect(body).toContain("> 1 of 2 lenses did not report normally");
        expect(body).toContain("2 lenses ran, 1 needing attention");
        expect(body).toContain("**caveman-review**: 0 findings, **needs attention**");
    });

    test("keeps a runaway lens detail on one line, inside its list item", () => {
        const body = review({
            lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true, detail: "x".repeat(2000) }],
        });

        const item = body.split("\n").find((line) => line.includes("xxx"));

        expect(item).toContain("(cut for length)");
        expect(item?.length).toBeLessThan(800);
    });

    test("says nothing about attention when every lens reported", () => {
        const body = review({ lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true }] });

        expect(body).toContain("1 lenses ran, all reporting");
        expect(body).not.toContain("needs attention");
    });

    test("lists what was suppressed and what was declined, separately", () => {
        const body = review({
            findings: [
                finding({ title: "Seen before", status: "already-reported" }),
                finding({ title: "Turned down", status: "declined" }),
            ],
        });

        expect(body).toContain("1 finding already commented on");
        expect(body).toContain("1 finding raised before and declined");
        expect(body).toContain("Seen before");
        expect(body).toContain("Turned down");
    });

    test("escapes a resolve reason, which is model prose inside a details block", () => {
        const body = review({}, { resolved: [{ reason: "the </details> case\nis gone" }] });

        expect(body).toContain("- the \\</details> case is gone");
    });

    test("says which threads were left open when the token could not resolve them", () => {
        const body = review({}, { resolveDenied: true, leftOpen: 2 });

        expect(body).toContain("2 threads judged finished could not be resolved");
    });

    test("links the run for the findings the body does not print", () => {
        const body = review(
            { findings: [finding({ severity: "high" })] },
            {
                env: {
                    GITHUB_SERVER_URL: "https://github.com",
                    GITHUB_REPOSITORY: "pocketarc/codeferret",
                    GITHUB_RUN_ID: "7",
                },
            },
        );

        expect(body).toContain("[this run](https://github.com/pocketarc/codeferret/actions/runs/7)");
    });
});
