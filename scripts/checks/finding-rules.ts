/**
 * Whether the repair rules still name fields merged-schema.json has.
 *
 * A rule naming a field the schema no longer has stops running, and check-findings.ts then
 * reports `shape valid` for a file that rule would have caught. The question is answerable
 * without a review, and asking it at the end of one would throw a review away to report a
 * typo here.
 *
 * Imported rather than spawned. `selfCheck` returns each kind of drift in an array of its
 * own, and a subprocess flattened all of it into a decoded stderr blob, so no failure here
 * could name the file it was about. Spawning also kept a `--self-check` mode on
 * check-findings.ts, which gave that command two jobs and left it juggling argv with an
 * `if (!path)` guard written twice.
 */

import { readSchema, selfCheck } from "../../review/finding-rules.ts";
import { fail } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkFindingRules(): Promise<Failures> {
    const list: Failures = [];
    const rules = selfCheck(await readSchema());
    const home = "review/finding-rules.ts";

    if (rules.stray.length > 0) {
        fail(list, home, `POLICY keys ${rules.stray.join(", ")}, which merged-schema.json has no field for`);
    }

    if (rules.unruled.length > 0) {
        fail(
            list,
            home,
            `names no rule for ${rules.unruled.join(", ")}, so a fault there drops the whole finding.` +
                " Add a POLICY entry, or list it in FATAL_FIELDS",
        );
    }

    if (rules.enumsLost.length > 0) {
        fail(
            list,
            "review/merged-schema.json",
            `carries no ${rules.enumsLost.join(" or ")} enum, so the repair that normalises it is not running`,
        );
    }

    if (list.length === 0) {
        console.log(`OK check-findings.ts: ${rules.rules} rule(s) name a field merged-schema.json has`);
    }

    return list;
}
