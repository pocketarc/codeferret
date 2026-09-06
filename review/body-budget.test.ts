import { describe, expect, test } from "bun:test";
import { assemble, boundedBlock, MAX_BODY } from "./body-budget.ts";
import type { Listing } from "./body-budget.ts";
import { plural } from "./words.ts";

describe("assemble", () => {
    /**
     * A listing of plain strings, because nothing in body-budget.ts names a finding.
     *
     * `review-body.test.ts` covers what the one real caller renders and what it says about the
     * items the budget dropped; these are about how many of them fit.
     */
    function listing(items: string[]): Listing<string> {
        return {
            heading: "Findings",
            lead: "lead",
            items,
            render: (item) => item,
            omitted: (missing) => `${plural(missing, "further finding")} left out for length.`,
        };
    }

    function item(title: string, length = 40): string {
        return `- **${title}** ${"x".repeat(length)}`;
    }

    test("keeps the fixed sections and lists what fits", () => {
        const { body } = assemble(["## CodeFerret"], listing([item("First"), item("Second")]), ["### Caveats"]);

        expect(body).toContain("## CodeFerret");
        expect(body).toContain("### Findings");
        expect(body).toContain("Second");
        expect(body).toEndWith("### Caveats");
    });

    test("leaves the listing out when there is nothing to list", () => {
        expect(assemble(["## CodeFerret"], null, []).body).toBe("## CodeFerret");
    });

    test("drops whole items rather than cutting one, and says how many went", () => {
        const items = Array.from({ length: 200 }, (_, i) => item(`T${i}`, 2000));
        const { body } = assemble(["## CodeFerret"], listing(items), []);

        expect(body.length).toBeLessThanOrEqual(MAX_BODY);
        expect(body).toMatch(/further findings? left out for length/);
    });

    test("an item too long for what is left costs only itself", () => {
        const items = [item("Huge", 3900), item("Small")];
        const { body } = assemble(["x".repeat(MAX_BODY - 3000)], listing(items), []);

        expect(body).not.toContain("Huge");
        expect(body).toContain("Small");
    });

    test("reports the items it printed, not the ones it was offered", () => {
        const items = [item("Huge", 3900), item("Small")];
        const { printed } = assemble(["x".repeat(MAX_BODY - 3000)], listing(items), []);

        expect(printed).toEqual([item("Small")]);
    });

    test("hands the omission line what it kept, so a caller can compare the two sets", () => {
        const items = [item("Huge", 3900), item("Small")];
        const seen: string[][] = [];
        const { body } = assemble(
            ["x".repeat(MAX_BODY - 3000)],
            {
                ...listing(items),
                omitted: (missing, kept) => {
                    seen.push(kept);

                    return `${missing} went, ${kept.length} stayed.`;
                },
            },
            [],
        );

        expect(seen).toEqual([[item("Small")]]);
        expect(body).toContain("1 went, 1 stayed.");
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
        const items = Array.from({ length: 200 }, (_, i) => item(`T${i}`, 2000));
        const { body } = assemble(["## CodeFerret"], listing(items), ["### Caveats"]);

        expect(body).toEndWith("### Caveats");
    });

    // The search needs `printedWith` monotone in `head`, which `cutToFit` does not give in
    // general: it skips rather than stops, so a wider head can drop one long item and admit
    // two short ones. These two fixtures are the same length, which is what makes it hold.
    describe("where the cut falls", () => {
        const first = item("First", 500);
        const second = item("Second", 500);
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

        test("lists an item that exactly fits, and drops it one character later", () => {
            expect(printedWith(widestHead(1))).toBe(1);
            expect(printedWith(widestHead(1) + 1)).toBe(0);
        });

        test("charges a second item its own length and the blank line before it, and nothing else", () => {
            expect(widestHead(2)).toBeGreaterThan(0);
            expect(widestHead(1) - widestHead(2)).toBe(second.length + 2);
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
