/** Each bundled lens's SKILL.md frontmatter, against what a lens agent needs of it. */

import { existsSync, readdirSync } from "node:fs";
import { fail, frontmatter } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkBundledSkills(): Promise<Failures> {
    const list: Failures = [];

    // One plugin, one namespace: a duplicated name, or one that disagrees with its
    // directory, leaves a lens silently unreachable.
    const seen = new Map<string, string>();

    for (const entry of readdirSync("lenses/skills", { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const skillFile = `lenses/skills/${entry.name}/SKILL.md`;

        if (!existsSync(skillFile)) {
            fail(list, skillFile, "bundled lens has no SKILL.md");
            continue;
        }

        const skill = await frontmatter(list, skillFile);
        if (!skill) continue;

        // On 2.1.220 the flag only hides the skill from the slash menu: Claude Code still
        // registers it and the model still sees it.
        if (skill["user-invocable"] === false) {
            fail(list, skillFile, `has \`user-invocable: false\`, which only hides \`/codeferret:${entry.name}\``);
        }

        // A lens agent loads its skill through the Skill tool, which counts as model
        // invocation. Left in, the lens loads no skill and returns nothing.
        if (skill["disable-model-invocation"] === true) {
            fail(list, skillFile, "has `disable-model-invocation: true`, so no lens agent could load it");
        }

        // Upstream writes a description to get the skill invoked, and a whole set of them
        // inside a code review tool would fire lenses during unrelated work.
        // prepare-skill.ts rewrites them.
        if (!String(skill.description ?? "").startsWith(`CodeFerret review lens ${entry.name}.`)) {
            fail(list, skillFile, `description is not scoped. Run: bun scripts/prepare-skill.ts ${skillFile} ${entry.name}`);
        }

        const declared = typeof skill.name === "string" ? skill.name.trim() : "";

        if (!declared) fail(list, skillFile, "no `name` in frontmatter");
        else if (declared !== entry.name) {
            fail(list, skillFile, `declares name '${declared}' but its directory is '${entry.name}'`);
        } else if (seen.has(declared)) {
            fail(list, skillFile, `name '${declared}' is already used by ${seen.get(declared)}`);
        } else seen.set(declared, skillFile);
    }

    console.log(`OK lenses/skills: ${seen.size} bundled lens(es), names unique`);
    return list;
}
