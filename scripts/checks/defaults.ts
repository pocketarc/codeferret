/** That every lens the action ships by default is one this repository bundles a skill for. */

import { existsSync } from "node:fs";
import { action, fail, inputLines } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkDefaults(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await action(list);
    if (!manifest) return list;

    const lenses = inputLines(list, "action.yml", "lenses", manifest.inputs?.lenses?.default);

    for (const lens of lenses) {
        if (!existsSync(`lenses/skills/${lens}/SKILL.md`)) {
            fail(list, "action.yml", `default lens '${lens}' has no bundled skill`);
        }
    }

    if (list.length === 0) {
        console.log("OK action.yml: every default lens has a bundled skill");
    }
    return list;
}
