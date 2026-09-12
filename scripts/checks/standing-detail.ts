/**
 * The standing caveats in review/standing-detail.ts, against the lenses they name.
 *
 * A key that names no lens fails in the dangerous direction and in silence: `caveatOf` in
 * review/caveats.ts returns nothing, the lens drops out of that file's `limited`, the
 * `[!NOTE]` above the health list stops counting it, and the review renders as though the
 * interface had been checked from a rendered page. No error, no warning, and every other
 * check here still passes.
 *
 * The same class as a misnamed `review/lens-extras/<lens>.md`, which build-lens-agents.ts
 * guards for the same reason. Lens names here do get added, renamed and removed.
 */

import { STANDING_DETAIL } from "../../review/standing-detail.ts";
import { bundledLenses, fail } from "./support.ts";
import type { Failures } from "./support.ts";

/**
 * The lenses whose extras rule out a capability the session does not have.
 *
 * `comment-review` is the fifth extras file and is deliberately absent: reading prose needs no
 * capability, so its extras rule out nothing.
 */
const MUST_CAVEAT = [
    "anthropic-accessibility-review",
    "copilot-sql-code-review",
    "copilot-web-design-reviewer",
    "vercel-next-best-practices",
];

export async function checkStandingDetail(): Promise<Failures> {
    const list: Failures = [];
    const file = "review/standing-detail.ts";

    const bundled = bundledLenses();

    for (const lens of STANDING_DETAIL.keys()) {
        if (!bundled.has(lens)) {
            fail(list, file, `names '${lens}', which is not a lens under lenses/skills/`);
        }
    }

    // Reported against the extras, because that is where a caveat is written and where a broken
    // `standing-detail` block leaves no entry. A lens that no longer ships is the other way to
    // get here, and comes off MUST_CAVEAT above.
    for (const lens of MUST_CAVEAT) {
        if (!STANDING_DETAIL.has(lens)) {
            fail(
                list,
                `review/lens-extras/${lens}.md`,
                `puts no standing caveat in ${file}, so a review reads as though it had reached what that lens cannot`,
            );
        }
    }

    if (list.length === 0) {
        console.log("OK standing-detail: every caveat names a bundled lens, and every lens owed one has it");
    }

    return list;
}
