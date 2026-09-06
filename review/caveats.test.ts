import { describe, expect, test } from "bun:test";
import { reopenedReasons } from "./caveats.ts";
import { MAY_DECLINE } from "./findings.ts";
import type { Vetted } from "./findings.ts";

/** A run that reopened nothing, which each case below adds one reopening to. */
const settled: Vetted = { findings: [], untraceable: 0, unrelated: 0, unvouched: 0, unreported: 0, unmatched: 0 };

/**
 * Associations GitHub answers that may not settle a finding.
 *
 * `MEMBER` is the one that matters: it is what came out of `MAY_DECLINE`, and GitHub answers it
 * for anybody in the organisation that owns the repository whether or not they can push here.
 */
const REFUSED = ["member", "contributor", "first-time contributor", "none"];

describe("the sentences a reader gets when a suppression is reopened", () => {
    test("reads out who could have settled the finding", () => {
        const [untraceable] = reopenedReasons({ ...settled, untraceable: 1 });
        const [unvouched] = reopenedReasons({ ...settled, unvouched: 1 });

        expect(untraceable).toContain("cited no comment from an owner or a collaborator,");
        expect(unvouched).toContain("with no owner or collaborator having said so");
    });

    // The rule and the sentences explaining it were four separate statements, and narrowing the
    // rule left the fourth behind; `ENTITLED_NAMED` in caveats.ts has what that cost a
    // maintainer. The sentences are read off `MAY_DECLINE` now, and this is what holds them to
    // it without re-deriving the phrasing here.
    test("names every association the rule admits and none it refuses", () => {
        const said = reopenedReasons({ ...settled, untraceable: 1, unvouched: 1 }).join(" ");

        for (const association of MAY_DECLINE) expect(said).toContain(association.toLowerCase());
        for (const association of REFUSED) expect(said).not.toContain(association);
    });
});
