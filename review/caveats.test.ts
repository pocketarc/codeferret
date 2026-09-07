import { describe, expect, test } from "bun:test";
import { reopenedReasons } from "./caveats.ts";
import { MAY_DECLINE, MAY_DECLINE_PERMISSIONS } from "./findings.ts";
import type { Vetted } from "./findings.ts";

/** A run that reopened nothing, which each case below adds one reopening to. */
const settled: Vetted = { findings: [], untraceable: 0, unrelated: 0, unvouched: 0, unreported: 0, unmatched: 0 };

const REFUSED = ["contributor", "first-time contributor", "none"];

describe("the sentences a reader gets when a suppression is reopened", () => {
    test("reads out who could have settled the finding", () => {
        const [untraceable] = reopenedReasons({ ...settled, untraceable: 1 });
        const [unvouched] = reopenedReasons({ ...settled, unvouched: 1 });

        expect(untraceable).toContain("cited no comment from");
        expect(untraceable).toContain("organization member with admin, maintain, or push permission on the repository");
        expect(unvouched).toContain("organization member with admin, maintain, or push permission on the repository");
    });

    test("names every association the rule admits and none it refuses", () => {
        const said = reopenedReasons({ ...settled, untraceable: 1, unvouched: 1 }).join(" ");

        for (const association of MAY_DECLINE) expect(said).toContain(association.toLowerCase());
        for (const permission of MAY_DECLINE_PERMISSIONS) expect(said).toContain(permission);
        for (const association of REFUSED) expect(said).not.toContain(association);
    });
});
