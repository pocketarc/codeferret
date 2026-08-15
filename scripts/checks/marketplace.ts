/** The marketplace manifest, and that each plugin it lists is the plugin it sources. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fail, MANIFEST_FILE, parseJson } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkMarketplace(): Promise<Failures> {
    const list: Failures = [];
    const file = ".claude-plugin/marketplace.json";
    const marketplace = (await parseJson(list, file)) as {
        name?: string;
        owner?: { name?: string };
        plugins?: Array<{ name?: string; source?: unknown }>;
    } | null;

    if (!marketplace) return list;

    if (!marketplace.name) fail(list, file, "missing `name`");
    if (!marketplace.owner?.name) fail(list, file, "missing `owner.name`");

    const plugins = marketplace.plugins ?? [];
    if (plugins.length === 0) fail(list, file, "lists no plugins");

    for (const entry of plugins) {
        if (!entry.name) {
            fail(list, file, "a plugin entry has no `name`");
            continue;
        }
        if (entry.source === undefined) {
            fail(list, file, `entry '${entry.name}' has no \`source\``);
            continue;
        }
        // A source can also name a git repository or an npm package. Only a path is
        // ours to check.
        if (typeof entry.source !== "string") continue;

        const sourced = join(entry.source, MANIFEST_FILE);
        if (!existsSync(sourced)) {
            fail(list, file, `entry '${entry.name}' sources '${entry.source}', which has no plugin.json`);
            continue;
        }

        const target = (await parseJson(list, sourced)) as { name?: string } | null;
        if (target && target.name !== entry.name) {
            fail(list, file, `entry '${entry.name}' sources a plugin named '${target.name}'`);
        }
    }

    console.log(`OK ${file}: marketplace '${marketplace.name}', ${plugins.length} plugin(s)`);
    return list;
}
