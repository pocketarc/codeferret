import { describe, expect, test } from "bun:test";
import { LensNameRefused, selectLenses } from "./select-lenses.ts";

const SHIPPED = ["caveman-review", "anthropic-code-review", "comment-review", "writing-review"].join("\n");

describe("selectLenses: what a run dispatches", () => {
    // The row `c271996` fixed in the shell. An unset `exclude-lenses` is the shipped default,
    // and it reached the subtraction as a lens name of "", which the name test refused.
    test("an empty exclude-lenses keeps the whole list, which is the shipped default", () => {
        expect(selectLenses(SHIPPED, "")).toEqual({ kept: SHIPPED.split("\n"), unmatched: [] });
        expect(selectLenses(SHIPPED, "\n\n  \n")).toEqual({ kept: SHIPPED.split("\n"), unmatched: [] });
    });

    test("a named lens comes out of the list", () => {
        expect(selectLenses(SHIPPED, "comment-review\nwriting-review")).toEqual({
            kept: ["caveman-review", "anthropic-code-review"],
            unmatched: [],
        });
    });

    // A workflow file writes both sides as a YAML block scalar, so the indentation is the
    // author's formatting rather than part of the name.
    test("both sides are trimmed, so an indented name still matches", () => {
        expect(selectLenses("  caveman-review\n\tcomment-review\n", "   comment-review  ")).toEqual({
            kept: ["caveman-review"],
            unmatched: [],
        });
    });

    test("a name that matches nothing is reported and the run carries on", () => {
        expect(selectLenses(SHIPPED, "no-such-lens")).toEqual({
            kept: SHIPPED.split("\n"),
            unmatched: ["no-such-lens"],
        });
    });

    test("naming a lens twice subtracts it once and reports the second", () => {
        expect(selectLenses(SHIPPED, "comment-review\ncomment-review")).toEqual({
            kept: ["caveman-review", "anthropic-code-review", "writing-review"],
            unmatched: ["comment-review"],
        });
    });

    test("the match is a whole name, so a prefix of one subtracts nothing", () => {
        expect(selectLenses(SHIPPED, "comment").unmatched).toEqual(["comment"]);
        expect(selectLenses(SHIPPED, "comment").kept).toEqual(SHIPPED.split("\n"));
    });
});

describe("selectLenses: what it refuses", () => {
    for (const name of ["../etc", "a/b", ".hidden", "a b", "$(id)"]) {
        test(`'${name}' is not a plain lens name`, () => {
            expect(() => selectLenses(SHIPPED, name)).toThrow(LensNameRefused);
        });
    }
});
