/**
 * The standing caveats in review-body.ts, against the lenses they name.
 *
 * A key that names no lens fails in the dangerous direction and in silence: `caveatOf`
 * gives nothing back, the lens drops out of `limited`, the `[!NOTE]` above the health list
 * stops counting it, and the review renders as though the interface had been checked from a
 * rendered page. No error, no warning, and every other check here still passes.
 *
 * The same class as a misnamed `review/lens-extras/<lens>.md`, which build-lens-agents.ts
 * guards for the same reason. Lens names here do get added, renamed and removed.
 */

import { STANDING_DETAIL } from "../../review/standing-detail.ts";
import { bundledLenses, fail } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkStandingDetail(): Promise<Failures> {
    const list: Failures = [];
    const file = "review/standing-detail.ts";

    // The map is generated from the `standing-detail` frontmatter of the extras files, and
    // checkGenerated re-runs that generator, so drift between the two is already covered.
    // What is left is the case the generator cannot see: every lens whose extras open by
    // naming a capability the session does not have should claim a sentence, and an empty
    // map means a review promises a caveat nobody wrote.
    if (STANDING_DETAIL.size === 0) {
        fail(list, file, "holds no caveat, so a review says nothing about what a lens could not reach");
        return list;
    }

    const bundled = bundledLenses();

    for (const lens of STANDING_DETAIL.keys()) {
        if (!bundled.has(lens)) {
            fail(list, file, `names '${lens}', which is not a lens under lenses/skills/`);
        }
    }

    if (list.length === 0) {
        console.log("OK standing-detail: every caveat names a bundled lens");
    }

    return list;
}
