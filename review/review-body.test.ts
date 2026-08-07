import { describe, expect, test } from "bun:test";
import { partition } from "./findings.ts";
import type { Finding, Merged } from "./findings.ts";
import { closeOpenFence, fenceMap } from "./markdown.ts";
import {
    assemble,
    bullet,
    composeReview,
    destinationOf,
    MAX_BODY,
    MAX_LENS_DETAIL,
    MAX_TITLE,
    mention,
} from "./review-body.ts";
import type { Posting } from "./review-body.ts";

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

describe("bullet", () => {
    test("escapes a trailing backslash in a title, which would eat the closing emphasis", () => {
        expect(bullet(finding({ title: "windows\\path\\" }))).toContain("**windows\\\\path\\\\**");
    });

    test("opens with the position, so a reader can jump to it", () => {
        expect(bullet(finding({ line: 42 }))).toStartWith("- `a.ts:42`: **A title**");
    });

    test("escapes a heading a body line would otherwise open", () => {
        expect(bullet(finding({ body: "# not a heading" }))).toContain("\\# not a heading");
    });

    test("escapes a block-level tag a body line would otherwise open", () => {
        expect(bullet(finding({ body: "<details>\nswallowed" }))).toContain("\\<details>");
    });

    test("escapes a tag partway along a line, which GitHub opens wherever it sits", () => {
        expect(bullet(finding({ body: "see the <details> element" }))).toContain("see the \\<details> element");
    });

    test("escapes a rule under a line of prose, which would make that line a heading", () => {
        expect(bullet(finding({ body: "A claim\n---" }))).toContain("\\---");
    });

    test("clamps a runaway body, so one finding cannot fill the whole listing", () => {
        expect(bullet(finding({ body: "x".repeat(20000) }))).toContain("(cut for length)");
    });

    test("keeps a multi-line title on one line, so the list item survives it", () => {
        expect(bullet(finding({ title: "One line\n\nand another" }))).toContain("**One line and another**");
    });

    test("widens the code span for a backtick in a path, which would otherwise close it", () => {
        expect(bullet(finding({ file: "a`b.ts", line: 2 }))).toStartWith("- ``a`b.ts:2``:");
    });

    test("leaves a comment inside a fenced block alone", () => {
        const body = ["```sh", "# a shell comment", "```"].join("\n");

        expect(bullet(finding({ body }))).toContain("# a shell comment");
    });

    test("renders a range as a span", () => {
        expect(bullet(finding({ line: 4, end_line: 9 }))).toContain("`a.ts:4-9`");
    });

    test("names the file alone when the finding has no usable line", () => {
        expect(bullet(finding({ line: undefined as unknown as number }))).toStartWith("- `a.ts`:");
    });

    test("names the file alone for a line of zero, which links nowhere", () => {
        expect(bullet(finding({ line: 0 }))).toStartWith("- `a.ts`:");
    });

    test("closes a fence the body left open, so the rest of the review is not code", () => {
        expect(bullet(finding({ body: "```sh\nx" }))).toContain("```sh\n  x\n  ```");
    });

    test("leaves the category line out when the finding has none", () => {
        expect(bullet(finding({ category: "" }))).not.toContain("undefined");
    });

    test("leaves the category line out for a category that is not a string", () => {
        expect(bullet(finding({ category: 3 as unknown as string }))).not.toEndWith("__");
    });

    test("keeps a multi-line category on one line, so it cannot open a heading below the item", () => {
        const line = bullet(finding({ category: "sql-injection\n\n# Findings" }));

        expect(line).toEndWith("_sql-injection # Findings_");
    });

    test("clamps a runaway title, so it is not a wall of bold text", () => {
        const line = bullet(finding({ title: "t".repeat(4000) })).split("\n")[0] ?? "";

        expect(line).toContain("(cut for length)");
        expect(line.length).toBeLessThan(MAX_TITLE + 200);
    });
});

describe("mention", () => {
    const onThePullRequest = new Set([
        "https://example.test/1",
        "not a url",
        "javascript:alert(1)",
        "https://example.test/a(b)",
    ]);

    test("links the thread when there is one", () => {
        expect(
            mention(finding({ existing_comment_url: "https://example.test/1" }), "thread", onThePullRequest),
        ).toBe("- A title (`a.ts:1`) ([thread](https://example.test/1))");
    });

    test("names the finding without a link when the previous run left no url", () => {
        expect(mention(finding(), "thread", onThePullRequest)).toBe("- A title (`a.ts:1`)");
    });

    test("drops a url that is not a link, rather than spilling it into the line", () => {
        expect(mention(finding({ existing_comment_url: "not a url" }), "thread", onThePullRequest)).toBe(
            "- A title (`a.ts:1`)",
        );
        expect(mention(finding({ existing_comment_url: "javascript:alert(1)" }), "thread", onThePullRequest)).toBe(
            "- A title (`a.ts:1`)",
        );
    });

    test("encodes the brackets that would end a link target early", () => {
        expect(
            mention(finding({ existing_comment_url: "https://example.test/a(b)" }), "thread", onThePullRequest),
        ).toContain("(https://example.test/a%28b%29)");
    });

    test("does not link a url no comment on the pull request carries", () => {
        expect(mention(finding({ existing_comment_url: "https://evil.test/x" }), "thread", onThePullRequest)).toBe(
            "- A title (`a.ts:1`)",
        );
    });

    test("bounds a runaway title, which would otherwise be a wall of text in the list", () => {
        const line = mention(finding({ title: "t".repeat(4000) }), "thread", onThePullRequest);

        expect(line.length).toBeLessThan(MAX_TITLE + 200);
    });
});

describe("destinationOf", () => {
    test("builds the run url from what a runner sets", () => {
        expect(
            destinationOf({
                GITHUB_SERVER_URL: "https://github.com",
                GITHUB_REPOSITORY: "pocketarc/codeferret",
                GITHUB_RUN_ID: "42",
            }),
        ).toEqual({ kind: "run", url: "https://github.com/pocketarc/codeferret/actions/runs/42" });
    });

    test("carries whether the run kept the findings file", () => {
        expect(
            destinationOf({
                GITHUB_SERVER_URL: "https://github.com",
                GITHUB_REPOSITORY: "pocketarc/codeferret",
                GITHUB_RUN_ID: "42",
                ARTIFACT_HAS_FINDINGS: "true",
            }),
        ).toEqual({ kind: "artifact", url: "https://github.com/pocketarc/codeferret/actions/runs/42" });
    });

    test("is a session outside a run, so nothing links a page that does not exist", () => {
        expect(destinationOf({ GITHUB_REPOSITORY: "pocketarc/codeferret" })).toEqual({ kind: "session" });
    });
});

describe("assemble", () => {
    function listing(items: Finding[]) {
        return { heading: "Findings", lead: "lead", omission: "They are in the findings file.", items };
    }

    test("keeps the fixed sections and lists what fits", () => {
        const { body } = assemble(
            ["## CodeFerret"],
            listing([finding(), finding({ title: "Second" })]),
            ["### Caveats"],
        );

        expect(body).toContain("## CodeFerret");
        expect(body).toContain("### Findings");
        expect(body).toContain("Second");
        expect(body).toEndWith("### Caveats");
    });

    test("leaves the listing out when there is nothing to list", () => {
        expect(assemble(["## CodeFerret"], null, []).body).toBe("## CodeFerret");
    });

    test("drops whole findings rather than cutting one, and says how many went", () => {
        const items = Array.from({ length: 200 }, (_, i) => finding({ title: `T${i}`, body: "x".repeat(2000) }));
        const { body } = assemble(["## CodeFerret"], listing(items), []);

        expect(body.length).toBeLessThanOrEqual(MAX_BODY);
        expect(body).toMatch(/further findings? left out for length/);
    });

    test("a finding too long for what is left costs only itself", () => {
        const items = [finding({ title: "Huge", body: "x".repeat(3900) }), finding({ title: "Small" })];
        const { body } = assemble(["x".repeat(MAX_BODY - 3000)], listing(items), []);

        expect(body).not.toContain("Huge");
        expect(body).toContain("Small");
    });

    test("reports the findings it printed, not the ones it was offered", () => {
        const items = [finding({ title: "Huge", body: "x".repeat(3900) }), finding({ title: "Small" })];
        const { printed } = assemble(["x".repeat(MAX_BODY - 3000)], listing(items), []);

        expect(printed.map((f) => f.title)).toEqual(["Small"]);
    });

    test("closes a details block the last-resort cut left open, and says so outside it", () => {
        const wide = Array.from({ length: 400 }, (_, i) => `- lens ${i}: ${"d".repeat(200)}`).join("\n");
        const { body } = assemble(
            ["## CodeFerret", `<details>\n<summary>lenses</summary>\n\n${wide}\n</details>`],
            null,
            [],
        );

        expect(body).toEndWith("</details>\n\n_(this review was cut for length)_");
        expect((body.match(/<details/g) ?? []).length).toBe((body.match(/<\/details>/g) ?? []).length);
    });

    test("the tail survives a listing that would fill the body", () => {
        const items = Array.from({ length: 200 }, (_, i) => finding({ title: `T${i}`, body: "x".repeat(2000) }));
        const { body } = assemble(["## CodeFerret"], listing(items), ["### Caveats"]);

        expect(body).toEndWith("### Caveats");
    });

    test("leaves no disclosure control the cut emptied", () => {
        const filler = Array.from({ length: 400 }, (_, i) => `- lens ${i}: ${"d".repeat(200)}`).join("\n");
        const { body } = assemble(
            [
                "## CodeFerret",
                `<details>\n<summary>lenses</summary>\n\n${filler}\n</details>`,
                `<details>\n<summary>2 findings raised before and declined</summary>\n\n- a\n</details>`,
            ],
            null,
            [],
        );

        expect(body).not.toMatch(/<details>\n(<summary>[^\n]*<\/summary>\n)?<\/details>/);
        expect((body.match(/<details/g) ?? []).length).toBe((body.match(/<\/details>/g) ?? []).length);
    });
});

describe("composeReview", () => {
    const quiet: Posting = {
        resolved: [],
        resolveDenied: false,
        leftOpen: 0,
        to: { kind: "session" },
        linkable: new Set(),
        dispatched: [],
        unread: [],
    };

    const onARunner = destinationOf({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "pocketarc/codeferret",
        GITHUB_RUN_ID: "7",
        ARTIFACT_HAS_FINDINGS: "true",
    });

    const withNoArtifact = destinationOf({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "pocketarc/codeferret",
        GITHUB_RUN_ID: "7",
    });

    function review(over: Partial<Merged> = {}, posting: Partial<Posting> = {}): string {
        const merged: Merged = { findings: [], ...over };

        return composeReview(merged, { ...quiet, ...posting }, partition(merged.findings)).body;
    }

    test("lists the critical and high findings when a run holds the rest", () => {
        const body = review({ findings: [finding({ severity: "high" })] }, { to: onARunner });

        expect(body).toContain("### Critical and high findings");
        expect(body).toContain("1 of 1 finding.");
    });

    test("heads no section when a run holds every finding and none is listed", () => {
        const body = review({ findings: [finding({ severity: "low" })] }, { to: onARunner });

        expect(body).not.toContain("### Findings");
        expect(body).toContain("No finding is critical or high.");
    });

    test("carries every finding when there is no run to hold them", () => {
        const body = review({ findings: [finding({ severity: "low", title: "A low one" })] });

        expect(body).toContain("### Findings");
        expect(body).toContain("A low one");
        expect(body).not.toContain("build directory");
    });

    test("lists a severity the schema does not carry rather than leaving it out", () => {
        const body = review({ findings: [finding({ severity: "Critical", title: "Odd label" })] }, { to: onARunner });

        expect(body).toContain("Odd label");
    });

    test("stops promising critical and high when a label nothing recognises is in the list", () => {
        const body = review({ findings: [finding({ severity: "sev1", title: "Odd label" })] }, { to: onARunner });

        expect(body).toContain("### Findings worth stopping for");
        expect(body).not.toContain("### Critical and high findings");
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
        expect(body).toContain("- caveman-review: 0 findings, **needs attention**");
    });

    test("keeps a runaway lens detail on one line, inside its list item", () => {
        const body = review({
            lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true, detail: "x".repeat(4000) }],
        });

        const item = body.split("\n").find((line) => line.includes("xxx"));

        // The marker is what `clamp` appends, unescaped, so it renders as an italic aside
        // rather than as underscores.
        expect(item).toContain("_(cut for length)_");
        expect(item?.length).toBeLessThan(MAX_LENS_DETAIL + 200);
    });

    test("names a dispatched lens the run reported no health for", () => {
        const body = review(
            { lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true }] },
            { dispatched: ["codeferret:x", "codeferret:anthropic-accessibility-review"] },
        );

        expect(body).toContain("> anthropic-accessibility-review ran and reported nothing about themselves");
    });

    test("says nothing about silent lenses when every dispatched one reported", () => {
        const body = review(
            { lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true }] },
            { dispatched: ["codeferret:x"] },
        );

        expect(body).not.toContain("reported nothing about themselves");
    });

    test("says so when the run reported no lens health at all, rather than going quiet", () => {
        const body = review({});

        expect(body).toContain("> [!WARNING]");
        expect(body).toContain("reported nothing about which lenses ran");
    });

    test("counts one lens as one lens", () => {
        const body = review({ lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true }] });

        expect(body).toContain("1 lens ran, all reporting");
        expect(body).not.toContain("needs attention");
    });

    test("gives a lens caveat a paragraph of its own, not the end of the count line", () => {
        const body = review({
            lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true, detail: "no rendered page" }],
        });

        expect(body).toContain("- x: 1 finding\n\n  no rendered page");
    });

    test("says what the two render-limited lenses could not check when neither said so", () => {
        const body = review({
            lens_health: [
                { lens: "codeferret:anthropic-accessibility-review", findings_returned: 4, ok: true },
                { lens: "codeferret:copilot-web-design-reviewer", findings_returned: 2, ok: true },
            ],
        });

        expect(body).toContain("> 2 of 2 lenses named something they could not check.");
        expect(body).toContain("No page was rendered");
        expect(body).toContain("No browser was available");
    });

    test("keeps the standing sentence beside the lens's own words rather than losing it", () => {
        const body = review({
            lens_health: [
                {
                    lens: "codeferret:anthropic-accessibility-review",
                    findings_returned: 4,
                    ok: true,
                    detail: "1.4.3 needs a rendered page",
                },
            ],
        });

        expect(body).toContain("1.4.3 needs a rendered page");
        expect(body).toContain("No page was rendered");
    });

    test("survives a lens named after an Object.prototype key", () => {
        const body = review({ lens_health: [{ lens: "codeferret:constructor", findings_returned: 0, ok: true }] });

        expect(body).toContain("- constructor: 0 findings");
    });

    test("says outside the block that a healthy lens could not check something", () => {
        const body = review({
            lens_health: [
                { lens: "codeferret:a11y", findings_returned: 2, ok: true, detail: "no rendered page, so no contrast" },
                { lens: "codeferret:x", findings_returned: 1, ok: true },
            ],
        });

        expect(body).toContain("> 1 of 2 lenses named something they could not check.");
    });

    test("escapes a heading a lens detail would otherwise open inside its list item", () => {
        const body = review({
            lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true, detail: "# not a heading" }],
        });

        expect(body).toContain("\\# not a heading");
    });

    test("escapes a heading the summary would otherwise open under the review's own", () => {
        const body = review({ summary: "# Risk\n\nSomething." });

        expect(body).toContain("\\# Risk");
    });

    test("closes a fence the summary left open, so the lens list is not swallowed", () => {
        const body = review({
            summary: "The risk:\n\n```ts\nconst x = 1;",
            lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true }],
        });

        expect(closeOpenFence(body)).toBe(body);
        expect(body).toContain("```ts\nconst x = 1;\n```");
        expect(fenceMap(body.split("\n"))[body.split("\n").indexOf("<details>")]).toBe(false);
    });

    test("closes a fence the caveats left open, so nothing below them is code", () => {
        const body = review({ notes: "Not checked:\n\n~~~\nthe rendered page" });

        expect(closeOpenFence(body)).toBe(body);
    });

    test("keeps a finding's own sample fenced when the summary opened a fence above it", () => {
        // Each section is escaped against its own fence map and GitHub parses the join, so an
        // unclosed fence above inverts the two readings and the escaping stops matching what
        // the page shows.
        const body = review({
            summary: "The risk:\n\n```ts\nconst x = 1;",
            findings: [finding({ body: "quoting a lens:\n\n```html\n<details>\n```" })],
        });

        const lines = body.split("\n");
        const fenced = fenceMap(lines);
        const sample = lines.findIndex((line) => line.includes("<details>"));

        expect(sample).toBeGreaterThan(-1);
        expect(fenced[sample]).toBe(true);
    });

    test("lists what was suppressed and what was declined, separately", () => {
        const body = review({
            findings: [
                finding({ title: "Seen before", status: "already-reported" }),
                finding({ title: "Turned down", status: "declined" }),
            ],
        });

        expect(body).toContain("1 finding raised in an earlier review");
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
        const body = review({ findings: [finding({ severity: "high" })] }, { to: onARunner });

        expect(body).toContain("[this run](https://github.com/pocketarc/codeferret/actions/runs/7)");
    });

    test("carries every finding when the run kept no artifact to defer to", () => {
        const body = review({ findings: [finding({ severity: "low", title: "A low one" })] }, { to: withNoArtifact });

        expect(body).toContain("A low one");
        expect(body).not.toContain("codeferret-run");
    });

    test("reports what composed the body, so a log beside it cannot disagree", () => {
        const merged: Merged = {
            findings: [finding({ severity: "high" }), finding({ severity: "low" })],
            lens_health: [{ lens: "codeferret:caveman-review", findings_returned: 2, ok: true }],
        };
        const composed = composeReview(
            merged,
            { ...quiet, to: onARunner, dispatched: ["codeferret:caveman-review"] },
            partition(merged.findings),
        );

        expect(composed.listed).toHaveLength(1);
        expect(composed.warned).toBe(false);
    });

    test("bounds the suppressed list, which assemble charges against the findings' budget", () => {
        const many = Array.from({ length: 120 }, (_, i) =>
            finding({ title: `Seen ${i}`, status: "already-reported" }),
        );
        const body = review({ findings: many });

        expect(body).toContain("120 findings raised in an earlier review");
        expect(body).toMatch(/80 further findings left out for length/);
        expect(body).not.toContain("Seen 119");
    });

    test("says what could not be read of the discussion, which is why findings repeat", () => {
        const body = review({}, { unread: ["the review threads could not be listed."] });

        expect(body).toContain("[!WARNING]");
        expect(body).toContain("the review threads could not be listed.");
    });

    test("escapes a heading a title would open at a list item's content column", () => {
        const body = review({ findings: [finding({ title: "# Fix the parser", status: "already-reported" })] });

        expect(body).toContain("- \\# Fix the parser");
    });

    test("sends a reader nowhere when the run kept no artifact, rather than to its log", () => {
        const items = Array.from({ length: 200 }, (_, i) => finding({ title: `T${i}`, body: "x".repeat(2000) }));
        const body = review({ findings: items }, { to: withNoArtifact });

        expect(body).toContain("the rest were kept nowhere");
        expect(body).not.toContain("in its log");
    });

    describe("what the body warns about, which is what makes a quiet run worth posting", () => {
        function warnedBy(over: Partial<Merged>, posting: Partial<Posting> = {}): boolean {
            const merged: Merged = { findings: [], ...over };

            return composeReview(merged, { ...quiet, ...posting }, partition(merged.findings)).warned;
        }

        const healthy = { lens: "codeferret:caveman-review", findings_returned: 0, ok: true };

        test("a run that accounted for none of its lenses", () => {
            expect(warnedBy({}, { dispatched: ["codeferret:caveman-review"] })).toBe(true);
        });

        test("a run whose lens_health is missing and whose dispatch list is too", () => {
            expect(warnedBy({})).toBe(true);
        });

        test("a lens that ran and reported nothing about itself", () => {
            expect(
                warnedBy(
                    { lens_health: [healthy] },
                    { dispatched: ["codeferret:caveman-review", "codeferret:writing-review"] },
                ),
            ).toBe(true);
        });

        test("a lens that reported itself broken", () => {
            expect(
                warnedBy(
                    { lens_health: [{ ...healthy, ok: false }] },
                    { dispatched: ["codeferret:caveman-review"] },
                ),
            ).toBe(true);
        });

        test("a thread the token could not close", () => {
            expect(
                warnedBy(
                    { lens_health: [healthy] },
                    { dispatched: ["codeferret:caveman-review"], resolveDenied: true, leftOpen: 1 },
                ),
            ).toBe(true);
        });

        test("every dispatched lens reporting normally", () => {
            expect(warnedBy({ lens_health: [healthy] }, { dispatched: ["codeferret:caveman-review"] })).toBe(false);
        });
    });
});
