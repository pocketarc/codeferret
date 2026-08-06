import { describe, expect, test } from "bun:test";
import {
    dropConnectorsSection,
    isPointerOnly,
    rewriteMarkdown,
    stripDeadLinks,
    substitutePlaceholders,
} from "./rewrite-markdown.ts";

const lines = (text: string): string[] => text.split("\n");
const text = (result: { lines: string[] }): string => result.lines.join("\n");

describe("dropConnectorsSection", () => {
    test("takes the heading and everything under it", () => {
        const source = ["## If Connectors Available", "", "Use Figma.", "", "### Deeper", "", "Still inside."];

        expect(text(dropConnectorsSection("s", source))).toBe("");
    });

    test("stops at the next heading of the same level", () => {
        const source = ["## If Connectors Available", "", "Use Figma.", "", "## After", "", "Back out."];

        expect(text(dropConnectorsSection("s", source))).toBe("## After\n\nBack out.");
    });

    test("leaves a heading inside a fenced block alone", () => {
        const source = ["```md", "## If Connectors Available", "```", "", "Kept."];

        expect(text(dropConnectorsSection("s", source))).toBe(source.join("\n"));
    });

    test("says what it dropped, because a vendored skill is diffed against its upstream", () => {
        expect(dropConnectorsSection("s", ["## If Connectors Available"]).notes).toHaveLength(1);
    });
});

describe("stripDeadLinks", () => {
    test("keeps the sentence and loses the link", () => {
        const source = lines("Check contrast against [the palette](../shared/palette.md), 4.5:1 for body text.");

        expect(text(stripDeadLinks("s", source))).toBe(
            "Check contrast against the palette, 4.5:1 for body text.",
        );
    });

    test("drops a line that was only a pointer at a file nobody vendored", () => {
        expect(text(stripDeadLinks("s", lines("See [the notes](../notes.md)."))).trim()).toBe("");
    });

    test("keeps an instruction that happens to carry a pointer", () => {
        const source = lines("Check the query plan, see [the notes](../notes.md)");

        expect(text(stripDeadLinks("s", source))).toContain("Check the query plan");
    });

    test("leaves a link inside a fenced block alone", () => {
        const source = ["```md", "[a](../b.md)", "```"];

        expect(text(stripDeadLinks("s", source))).toBe(source.join("\n"));
    });

    test("takes an image whole, leaving its alt text and no stray sigil", () => {
        const source = lines("The layout is ![Diagram](../img/d.png) roughly.");

        expect(text(stripDeadLinks("s", source))).toBe("The layout is Diagram roughly.");
    });

    test("drops an image that was the whole line, since the picture is not here", () => {
        expect(text(stripDeadLinks("s", lines("![Diagram](../img/d.png)"))).trim()).toBe("");
    });

    test("keeps a list item whose link names nothing", () => {
        const source = lines("- A caption that matters [](../x.md) and more besides");

        expect(text(stripDeadLinks("s", source))).toBe("- A caption that matters  and more besides");
    });

    test("closes the blank-line pair a dropped line leaves behind", () => {
        const source = lines("Before.\n\n[the notes](../notes.md)\n\nAfter.");

        expect(text(stripDeadLinks("s", source))).toBe("Before.\n\nAfter.");
    });
});

describe("isPointerOnly", () => {
    test("is false for a list item carrying content after the pointer", () => {
        expect(
            isPointerOnly("- the palette is the source of truth; body text is 4.5:1", ["the palette"]),
        ).toBe(false);
    });

    test("is true for a bare list item naming the link", () => {
        expect(isPointerOnly("- the palette", ["the palette"])).toBe(true);
    });

    test("is true for a directive that trails off in filler", () => {
        expect(isPointerOnly("See the notes for more details.", ["the notes"])).toBe(true);
    });

    test("is false for prose that neither directs nor is only the pointer", () => {
        expect(isPointerOnly("The palette defines eight ramps.", ["the palette"])).toBe(false);
    });

    test("is false when an instruction precedes the pointer", () => {
        expect(isPointerOnly("Check the query plan, see the notes", ["the notes"])).toBe(false);
    });

    test("is false when the sentence carries a threshold after the pointer", () => {
        expect(
            isPointerOnly("Check contrast against the palette, 4.5:1 for body text.", ["the palette"]),
        ).toBe(false);
    });
});

describe("substitutePlaceholders", () => {
    test("names the diff where a slash command would have passed an argument", () => {
        expect(text(substitutePlaceholders("s", lines("Audit @$1 and ${selection}")))).toBe(
            "Audit the diff under review and the diff under review",
        );
    });

    test("leaves a bare bind placeholder alone, which is what a SQL skill is vendored for", () => {
        expect(text(substitutePlaceholders("s", lines("WHERE id = $1")))).toBe("WHERE id = $1");
    });

    test("leaves a placeholder inside a fenced block alone, where it is being shown", () => {
        const source = ["```sh", "/review $ARGUMENTS", "```"];

        expect(text(substitutePlaceholders("s", source))).toBe(source.join("\n"));
    });

    test("drops the whole-project offer that qualified the placeholder", () => {
        expect(
            text(substitutePlaceholders("s", lines("Review ${selection} (or entire project if no selection) now"))),
        ).toBe("Review the diff under review now");
    });

    test("drops that offer from a skill vendored before this pass existed", () => {
        expect(
            text(substitutePlaceholders("s", lines("Review the diff under review (or entire project if no selection)"))),
        ).toBe("Review the diff under review");
    });

    test("leaves a parenthetical that is not that offer", () => {
        const source = "Review the schema (or the migration that changes it)";

        expect(text(substitutePlaceholders("s", lines(source)))).toBe(source);
    });
});

describe("rewriteMarkdown", () => {
    test("keeps a fence of the other kind inside a block as content, so the block does not read as closed", () => {
        const source = [
            "```sh",
            "~~~",
            'echo "$ARGUMENTS"',
            "```",
            "",
            "Read [the guide](../g.md) before you start.",
            "",
            "## If Connectors Available",
            "",
            "Use Figma.",
        ].join("\n");

        const { text: out } = rewriteMarkdown("s", source);

        expect(out).toContain('echo "$ARGUMENTS"');
        expect(out).not.toContain("If Connectors Available");
        expect(out).toContain("Read the guide before you start.");
        expect(out).not.toContain("../g.md");
    });
});
