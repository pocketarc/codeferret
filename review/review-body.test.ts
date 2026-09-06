import { describe, expect, test } from "bun:test";
import { partition } from "./findings.ts";
import type { Finding, Merged } from "./findings.ts";
import { COVERAGE_NOTICES, coverageOf, noticesFor } from "./caveats.ts";
import { closeOpenFence, escapeInline, fenceMap } from "./markdown.ts";
import {
    assemble,
    boundedBlock,
    bullet,
    composeReview,
    destinationOf,
    MAX_BODY,
    MAX_LENS_DETAIL,
    MAX_PATH,
    MAX_TITLE,
    mention,
} from "./review-body.ts";
import type { Posting } from "./review-body.ts";
import { REVIEW_THRESHOLD } from "./read-run.ts";
import { finding, NO_RISK, riskFor } from "./test-fixtures.ts";
import { plural } from "./words.ts";

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

        expect(line).toEndWith("_sql-injection \\# Findings_");
    });

    test("clamps a runaway title, so it is not a wall of bold text", () => {
        const line = bullet(finding({ title: "t".repeat(4000) })).split("\n")[0] ?? "";

        expect(line).toContain("(cut for length)");
        expect(line.length).toBeLessThan(MAX_TITLE + 200);
    });

    test("bounds a runaway path, which nothing upstream bounds", () => {
        const line = bullet(finding({ file: "a/".repeat(5000) })).split("\n")[0] ?? "";

        expect(line.length).toBeLessThan(MAX_PATH + 100);
    });

    test("keeps the line number beside a path the bound cut", () => {
        const line = bullet(finding({ file: `${"a/".repeat(5000)}b.ts`, line: 42 })).split("\n")[0] ?? "";

        expect(line).toContain(":42`");
    });

    test("bounds a runaway category, and marks the cut outside the emphasis", () => {
        const line = bullet(finding({ category: "c".repeat(9000) })).split("\n").at(-1) ?? "";

        expect(line.length).toBeLessThan(200);
        expect(line).toEndWith("_ (cut for length)");
    });

    // The cut lands inside the span, because a span may hold the space `clamp` cuts on.
    test("leaves no code span open when the cut lands inside one", () => {
        const title = `Quote the ref in ${"x".repeat(160)} \`git rev-parse --verify -- $ref\` now`;
        const line = bullet(finding({ title })).split("\n")[0] ?? "";

        expect(line).toContain("git rev-parse");
        expect(line).toContain("(cut for length)");
        expect((line.match(/(?<!\\)`/g) ?? []).length % 2).toBe(0);
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
        ).toBe("- `a.ts:1`: A title ([thread](https://example.test/1))");
    });

    test("names the finding without a link when the previous run left no url", () => {
        expect(mention(finding(), "thread", onThePullRequest)).toBe("- `a.ts:1`: A title");
    });

    test("drops a url that is not a link, rather than spilling it into the line", () => {
        expect(mention(finding({ existing_comment_url: "not a url" }), "thread", onThePullRequest)).toBe(
            "- `a.ts:1`: A title",
        );
        expect(mention(finding({ existing_comment_url: "javascript:alert(1)" }), "thread", onThePullRequest)).toBe(
            "- `a.ts:1`: A title",
        );
    });

    test("encodes the brackets that would end a link target early", () => {
        expect(
            mention(finding({ existing_comment_url: "https://example.test/a(b)" }), "thread", onThePullRequest),
        ).toContain("(https://example.test/a%28b%29)");
    });

    test("does not link a url no comment on the pull request carries", () => {
        expect(mention(finding({ existing_comment_url: "https://evil.test/x" }), "thread", onThePullRequest)).toBe(
            "- `a.ts:1`: A title",
        );
    });

    test("bounds a runaway title, which would otherwise be a wall of text in the list", () => {
        const line = mention(finding({ title: "t".repeat(4000) }), "thread", onThePullRequest);

        expect(line.length).toBeLessThan(MAX_TITLE + 200);
    });

    test("bounds a runaway path, which the tail is charged for before any finding", () => {
        const line = mention(finding({ file: "a/".repeat(5000) }), "thread", onThePullRequest);

        expect(line.length).toBeLessThan(MAX_PATH + MAX_TITLE + 100);
    });
});

describe("destinationOf", () => {
    test("keeps no url for a run that kept nothing, because there is nowhere to send a reader", () => {
        expect(
            destinationOf({
                GITHUB_SERVER_URL: "https://github.com",
                GITHUB_REPOSITORY: "pocketarc/codeferret",
                GITHUB_RUN_ID: "42",
            }),
        ).toEqual({ kind: "run" });
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

    test("says on the page when what it dropped rates above what it printed", () => {
        const items = [
            finding({ title: "Huge", body: "x".repeat(3900), risk: riskFor("critical") }),
            finding({ title: "Small", risk: riskFor("low") }),
        ];
        const { body } = assemble(["x".repeat(MAX_BODY - 3000)], listing(items), []);

        expect(body).toContain("Small");
        expect(body).toContain("one of them rated above a finding printed here");
        expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    });

    test("says nothing of the sort when the findings it dropped are the lesser ones", () => {
        const items = [
            finding({ title: "First", risk: riskFor("critical") }),
            finding({ title: "Second", body: "x".repeat(3900), risk: riskFor("low") }),
        ];
        const { body } = assemble(["x".repeat(MAX_BODY - 3000)], listing(items), []);

        expect(body).toContain("First");
        expect(body).toContain("left out for length");
        expect(body).not.toContain("rated above");
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

    // The search needs `printedWith` monotone in `head`, which `cutToFit` does not give in
    // general: it skips rather than stops, so a wider head can drop one long item and admit
    // two short ones. These two fixtures are the same length, which is what makes it hold.
    describe("where the cut falls", () => {
        const first = finding({ title: "First", body: "x".repeat(500) });
        const second = finding({ title: "Second", body: "y".repeat(500) });
        const items = [first, second];

        function printedWith(head: number): number {
            return assemble(["x".repeat(head)], listing(items), []).printed.length;
        }

        function widestHead(count: number): number {
            let low = 0;
            let high = MAX_BODY;

            while (low < high) {
                const mid = Math.ceil((low + high) / 2);

                if (printedWith(mid) >= count) low = mid;
                else high = mid - 1;
            }

            return low;
        }

        test("lists a finding that exactly fits, and drops it one character later", () => {
            expect(printedWith(widestHead(1))).toBe(1);
            expect(printedWith(widestHead(1) + 1)).toBe(0);
        });

        test("charges a second finding its bullet and the blank line before it, and nothing else", () => {
            expect(widestHead(2)).toBeGreaterThan(0);
            expect(widestHead(1) - widestHead(2)).toBe(bullet(second).length + 2);
        });
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

describe("boundedBlock", () => {
    const furtherItems = (n: number): string => plural(n, "further item");

    test("holds a block to its limit when the line about what was dropped is what would overrun it", () => {
        const items = Array.from({ length: 5 }, (_, i) => `- item ${i} ${"x".repeat(90)}`);
        const block = boundedBlock(items, 400, furtherItems);

        expect(block).toContain("left out for length");
        expect(block.length).toBeLessThanOrEqual(400);
    });

    test("leaves a list that fits whole, with no line about omissions", () => {
        expect(boundedBlock(["- one", "- two"], 400, furtherItems)).toBe("- one\n- two");
    });
});

describe("composeReview", () => {
    const quiet: Posting = {
        resolved: [],
        resolveDenied: false,
        leftOpen: 0,
        to: { kind: "session" },
        threshold: REVIEW_THRESHOLD,
        linkable: new Set(),
        dispatched: [],
        unread: [],
        sessionChanged: [],
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

    test("lists the findings at the threshold and above when a run holds the rest", () => {
        const body = review({ findings: [finding({ risk: riskFor("high") })] }, { to: onARunner });

        expect(body).toContain(`### Findings rated ${REVIEW_THRESHOLD} and above`);
        expect(body).toContain("1 of 1 finding.");
    });

    test("heads no section when a run holds every finding and none is listed", () => {
        const body = review({ findings: [finding({ risk: riskFor("low") })] }, { to: onARunner });

        expect(body).not.toContain("### Findings");
        expect(body).toContain(`Nothing rates ${REVIEW_THRESHOLD} or above.`);
    });

    test("carries every finding when there is no run to hold them", () => {
        const body = review({ findings: [finding({ risk: riskFor("low"), title: "A low one" })] });

        expect(body).toContain("### Findings");
        expect(body).toContain("A low one");
        expect(body).not.toContain("build directory");
    });

    test("names the threshold in the heading whatever scored above it", () => {
        const body = review({ findings: [finding({ risk: riskFor("critical") })] }, { to: onARunner });

        expect(body).toContain(`### Findings rated ${REVIEW_THRESHOLD} and above`);
    });

    test("leaves out a finding whose risk scores nothing, which is a nit", () => {
        const body = review({ findings: [finding({ risk: NO_RISK, title: "Rated nothing" })] }, { to: onARunner });

        expect(body).not.toContain("Rated nothing");
        expect(body).toContain(`Nothing rates ${REVIEW_THRESHOLD} or above.`);
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

    test("leaves no code span open when a lens caveat is cut inside one", () => {
        const detail = `${"word ".repeat(396)}\`@media (prefers-reduced-motion: reduce)\` is missing`;
        const body = review({ lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true, detail }] });
        const item = body.split("\n").find((line) => line.includes("@media")) ?? "";

        expect(item).toContain("_(cut for length)_");
        expect((item.match(/(?<!\\)`/g) ?? []).length % 2).toBe(0);
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
        expect(body).toContain("contrast, focus order, target size, reflow");
        expect(body).toContain("the mobile, tablet, desktop and wide viewport sweep");
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
        const body = review({ findings: [finding({ risk: riskFor("high") })] }, { to: onARunner });

        expect(body).toContain("[this run](https://github.com/pocketarc/codeferret/actions/runs/7)");
    });

    test("carries every finding when the run kept no artifact to defer to", () => {
        const body = review(
            { findings: [finding({ risk: riskFor("low"), title: "A low one" })] },
            { to: withNoArtifact },
        );

        expect(body).toContain("A low one");
        expect(body).not.toContain("codeferret-run");
    });

    test("reports what composed the body, so a log beside it cannot disagree", () => {
        const merged: Merged = {
            findings: [finding({ risk: riskFor("high") }), finding({ risk: riskFor("low") })],
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
            finding({ title: `Seen ${i} ${"t".repeat(100)}`, status: "already-reported" }),
        );
        const body = review({ findings: many });

        expect(body).toContain("120 findings raised in an earlier review");
        expect(body).toMatch(/\d+ further findings left out for length/);
        expect(body).not.toContain("Seen 119");
    });

    // Few enough to sit inside the forty-item count the tail used to be held to, and long enough
    // together to take several times the space that count was budgeted for.
    test("bounds the suppressed list by length, not by how many lines it holds", () => {
        const many = Array.from({ length: 30 }, (_, i) =>
            finding({ title: `Seen ${i} ${"word ".repeat(38)}`, status: "already-reported" }),
        );
        const body = review({ findings: many });

        expect(body).toContain("30 findings raised in an earlier review");
        expect(body).toMatch(/\d+ further findings left out for length/);
    });

    // The tail is charged against the body before a single finding bullet is measured, so what an
    // unbounded path in a suppressed finding costs is the findings section.
    test("lists a new finding beside suppressed findings carrying runaway paths", () => {
        const suppressed = Array.from({ length: 40 }, (_, i) =>
            finding({ title: `Seen ${i}`, file: `${"a/".repeat(4000)}${i}.ts`, status: "already-reported" }),
        );
        const body = review({ findings: [...suppressed, finding({ title: "Still worth reading" })] });

        expect(body).toContain("Still worth reading");
        expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    });

    test("counts the lenses it left out as lenses", () => {
        const body = review({
            lens_health: Array.from({ length: 12 }, (_, i) => ({
                lens: `codeferret:lens-${i}`,
                findings_returned: 1,
                ok: true,
                detail: "d".repeat(MAX_LENS_DETAIL - 100),
            })),
        });

        expect(body).toMatch(/- _\d+ lenses left out for length\._/);
        expect(body).not.toContain("lenss");
    });

    test("escapes a heading a lens name would open in the lens list", () => {
        const body = review({ lens_health: [{ lens: "codeferret:# Big", findings_returned: 3, ok: true }] });

        expect(body).toContain("- \\# Big: 3 findings");
    });

    test("bounds a runaway lens name rather than escaping the whole of it", () => {
        const long = `codeferret:${"n".repeat(9000)}`;
        const body = review({ lens_health: [{ lens: long, findings_returned: 0, ok: true }] });
        const item = body.split("\n").find((line) => line.startsWith("- nnn")) ?? "";

        expect(item.length).toBeLessThan(300);
    });

    test("escapes a heading a silent lens's name would open at the alert's content column", () => {
        const body = review(
            { lens_health: [{ lens: "codeferret:x", findings_returned: 1, ok: true }] },
            { dispatched: ["codeferret:x", "codeferret:# foo"] },
        );

        expect(body).toContain("> \\# foo ran and reported nothing about themselves");
        expect(body).not.toContain("> # foo");
    });

    test("names an input the session changed, which is what the lens counts rest on", () => {
        const body = review({}, { sessionChanged: ["diff-args", "lenses.txt"] });

        expect(body).toContain("[!WARNING]");
        expect(body).toContain("changed diff-args, lenses.txt under it");
    });

    test("says what could not be read of the discussion, which is why findings repeat", () => {
        const body = review({}, { unread: ["the review threads could not be listed."] });

        expect(body).toContain("[!WARNING]");
        expect(body).toContain("the review threads could not be listed.");
    });

    test("escapes a heading a title would open at a list item's content column", () => {
        const body = review({ findings: [finding({ title: "# Fix the parser", status: "already-reported" })] });

        expect(body).toContain("`a.ts:1`: \\# Fix the parser");
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

        test("a lens that named something it could not check is enough on its own, note or not", () => {
            const limited = { lens: "codeferret:anthropic-accessibility-review", findings_returned: 0, ok: true };

            expect(
                warnedBy(
                    { lens_health: [limited] },
                    { dispatched: ["codeferret:anthropic-accessibility-review"] },
                ),
            ).toBe(true);
        });

        // action.yml's whole default, which is what a consumer excluding nothing runs. A lens
        // shipping without the capability its skill describes has something to say on every
        // run, so this is the ordinary quiet push: the pull request gets a comment carrying
        // nothing but what the review could not cover.
        test("the shipped default with nothing new and nothing broken posts the coverage anyway", () => {
            const lenses = [
                "caveman-review",
                "anthropic-code-review",
                "wshobson-code-review-excellence",
                "cursor-thermo-nuclear-review",
                "sentry-security-review",
                "copilot-security-review",
                "vercel-next-best-practices",
                "copilot-web-design-reviewer",
                "copilot-sql-code-review",
                "anthropic-accessibility-review",
                "comment-review",
                "writing-review",
            ].map((name) => `codeferret:${name}`);

            expect(
                warnedBy(
                    { lens_health: lenses.map((lens) => ({ lens, findings_returned: 0, ok: true })) },
                    { dispatched: lenses },
                ),
            ).toBe(true);
        });

        test("a run where every lens ran and none had anything to declare stays quiet", () => {
            const lenses = ["codeferret:caveman-review", "codeferret:anthropic-code-review"];

            expect(
                warnedBy(
                    { lens_health: lenses.map((lens) => ({ lens, findings_returned: 0, ok: true })) },
                    { dispatched: lenses },
                ),
            ).toBe(false);
        });

        test("an input the session changed under the run", () => {
            expect(
                warnedBy({ lens_health: [healthy] }, { dispatched: ["codeferret:caveman-review"], sessionChanged: ["lenses.txt"] }),
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

        test("a thread left open by anything other than a refusal", () => {
            expect(
                warnedBy(
                    { lens_health: [healthy] },
                    { dispatched: ["codeferret:caveman-review"], resolveDenied: false, leftOpen: 1 },
                ),
            ).toBe(true);
        });

        test("every dispatched lens reporting normally", () => {
            expect(warnedBy({ lens_health: [healthy] }, { dispatched: ["codeferret:caveman-review"] })).toBe(false);
        });
    });

    describe("a warning raised is a warning printed", () => {
        test("says which threads were left open when nothing refused, rather than only on stderr", () => {
            const body = review({}, { resolveDenied: false, leftOpen: 2 });

            expect(body).toContain("2 threads judged finished could not be closed");
        });

        test("reports a lens that broke and a lens that named a limit, not the first of the two", () => {
            const body = review({
                lens_health: [
                    { lens: "codeferret:caveman-review", findings_returned: 0, ok: false },
                    { lens: "codeferret:anthropic-accessibility-review", findings_returned: 2, ok: true },
                ],
            });

            expect(body).toContain("did not report normally");
            expect(body).toContain("named something they could not check");
        });

        test("names the silent lenses even when the run accounted for none of them", () => {
            const body = review({}, { dispatched: ["codeferret:caveman-review"] });

            expect(body).toContain("reported nothing about which lenses ran");
            expect(body).toContain("caveman-review ran and reported nothing about themselves");
        });

        test("carries a sentence for every notice a run can raise at once", () => {
            const merged: Merged = {
                findings: [],
                lens_health: [
                    { lens: "codeferret:caveman-review", findings_returned: 0, ok: false },
                    { lens: "codeferret:anthropic-accessibility-review", findings_returned: 2, ok: true },
                ],
            };
            const posting: Posting = {
                ...quiet,
                dispatched: ["codeferret:caveman-review", "codeferret:anthropic-accessibility-review", "codeferret:x"],
                unread: ["the review threads could not be listed."],
                sessionChanged: ["lenses.txt"],
                resolveDenied: true,
                leftOpen: 1,
            };
            const coverage = coverageOf(merged, posting);
            const { body, warned } = composeReview(merged, posting, partition(merged.findings));

            // `unaccounted` is the one that cannot join them: it means an empty `lens_health`,
            // which leaves `broken`, `limited` and the lens block with nothing to report. The
            // test above pairs it with `silent`, which is the only notice it can share a body
            // with.
            expect(warned).toBe(true);
            expect(noticesFor(coverage)).toEqual(["unread", "changed", "silent", "broken", "limited"]);

            for (const name of noticesFor(coverage)) {
                expect(body).toContain(COVERAGE_NOTICES[name].say(coverage, escapeInline));
            }
        });

        test("says on the page when a finding could not be rated, and prints it anyway", () => {
            const merged: Merged = {
                findings: [
                    finding({ file: "scored.ts", risk: riskFor("nit") }),
                    finding({ file: "unrated.ts", title: "No risk at all", risk: undefined }),
                ],
            };
            // On a runner, so there is an artifact to defer the rest to and the tier actually
            // filters. With no artifact the body prints every finding and the case proves nothing.
            const posting: Posting = { ...quiet, to: onARunner };
            const coverage = coverageOf(merged, posting);
            const { body, warned } = composeReview(merged, posting, partition(merged.findings));

            // Both findings band to `nit`. The rated one is left out, which is what a tier is
            // for; the unrated one is not, because its tier is the output of a rating that did
            // not happen. Without the notice it would be in the list with nothing saying why.
            expect(noticesFor(coverage)).toContain("unrated");
            expect(body).toContain("could not be rated");
            expect(body).toContain("No risk at all");
            expect(body).not.toContain("scored.ts");
            expect(warned).toBe(true);
        });

        test("a lens's standing caveat is enough to post a run that found nothing new", () => {
            const merged: Merged = {
                findings: [],
                lens_health: [{ lens: "codeferret:anthropic-accessibility-review", findings_returned: 0, ok: true }],
            };
            const posting: Posting = { ...quiet, dispatched: ["codeferret:anthropic-accessibility-review"] };
            const { body, warned } = composeReview(merged, posting, partition(merged.findings));

            expect(noticesFor(coverageOf(merged, posting))).toEqual(["limited"]);
            expect(body).toContain("No page was rendered");
            expect(warned).toBe(true);
        });

        test("counts as unrated only the findings it posts, which are the ones it says it prints", () => {
            const merged: Merged = {
                findings: [
                    finding({ file: "posted.ts", risk: undefined }),
                    finding({ file: "answered.ts", risk: undefined, status: "already-reported" }),
                    finding({ file: "settled.ts", risk: undefined, status: "declined" }),
                ],
            };

            expect(coverageOf(merged, quiet).unrated.map((f) => f.file)).toEqual(["posted.ts"]);
        });

        test("bounds the unrated paths, which the body is charged for before any finding", () => {
            const merged: Merged = {
                findings: Array.from({ length: 40 }, (_, i) =>
                    finding({ file: `${"p".repeat(200)}/${i}.ts`, risk: undefined }),
                ),
            };
            const sentence = COVERAGE_NOTICES.unrated.say(coverageOf(merged, quiet), (text) => text);

            expect(sentence).toContain("(cut for length)");
            expect(sentence.length).toBeLessThan(1000);
        });

        test("bounds what the fetch could not read, which the body is charged for before any finding", () => {
            const body = review({}, { unread: ["e".repeat(9000)] });

            expect(body).toContain("(cut for length)");
            expect(body.length).toBeLessThan(3000);
        });
    });
});
