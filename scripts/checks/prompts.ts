/**
 * The frontmatter every command and lens agent needs to be reachable at all.
 *
 * A command whose frontmatter will not parse, or that has no description, never shows up in
 * the slash menu: the feature ships and nobody can find it.
 */

import { existsSync, readdirSync } from "node:fs";
import { fail, frontmatter } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkPrompts(): Promise<Failures> {
    const list: Failures = [];

    const wanted: Array<[string, string[]]> = [
        ["commands", ["description"]],
        ["agents", ["name", "description", "tools"]],
    ];

    for (const [dir, required] of wanted) {
        for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
            if (!entry.endsWith(".md")) continue;

            const file = `${dir}/${entry}`;
            const parsed = await frontmatter(list, file);
            if (!parsed) continue;

            const missing = required.filter((key) => !parsed[key]);
            if (missing.length > 0) fail(list, file, `frontmatter has no ${missing.map((k) => `\`${k}\``).join(", ")}`);
            else console.log(`OK ${file}`);
        }
    }

    return list;
}
