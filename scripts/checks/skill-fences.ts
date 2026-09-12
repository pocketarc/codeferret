/**
 * That every vendored markdown file's fences balance.
 *
 * A closing fence may be indented up to three spaces and need not match its opener's length,
 * so a nested sample closes the template it is nested in. From there the reading is inverted:
 * what was meant as the template renders as live markdown, and the delimiter meant to close
 * it opens a block nothing closes, so the rest of the page is one grey box. Two of the
 * bundled skills arrived that way and neither was noticed for as long as it took a lens to
 * read one.
 *
 * The rendering is the smaller half. `rewrite-markdown.ts` skips every line `fenceMap` calls
 * fenced, so a swallowed tail is a region `stripDeadLinks` and `substitutePlaceholders` never
 * reach, and a `../` link or a `$ARGUMENTS` there survives into the lens's own instructions.
 *
 * Refused rather than repaired. A repair has to guess which delimiter was meant as the
 * closer, and an attempt at it settled one of these two files onto the wrong opener and
 * swallowed the whole document. What the fix takes is raising the enclosing fence, and a
 * person with the upstream page in front of them can see which one that is. So the
 * correction is a deliberate edit to the vendored file, and this check is what stops a
 * re-vendor dropping it in silence.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { closeOpenFence } from "../../review/markdown.ts";
import { fail } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkSkillFences(): Promise<Failures> {
    const list: Failures = [];
    const root = "lenses/skills";
    let checked = 0;

    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        for (const name of readdirSync(join(root, entry.name), { recursive: true }) as string[]) {
            if (!name.endsWith(".md")) continue;

            const file = join(root, entry.name, name);
            const text = await Bun.file(file).text();
            checked += 1;

            // `closeOpenFence` hands back what it was given when nothing is open, so the
            // comparison is the balance test and there is no second reading of the fences.
            if (closeOpenFence(text) !== text) {
                fail(list, file, "ends inside a fenced block, so a nested fence closed one it was meant to sit in");
            }
        }
    }

    if (list.length === 0) console.log(`OK lenses/skills: ${checked} markdown file(s) with balanced fences`);

    return list;
}
