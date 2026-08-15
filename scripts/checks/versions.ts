/**
 * The version each shipped file offers a consumer to pin, against the manifest.
 *
 * A pinned version in one of those files is the one escape hatch from the mutable `@v1`.
 * Advice naming a tag nobody cut fails a consumer's job at load with "unable to find
 * version", and the release procedure moves the tag and `version` together, so the manifest
 * is what they have to agree with.
 */

import { existsSync } from "node:fs";
import { fail, MANIFEST_FILE, pluginManifest, TEMPLATE } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkShippedVersions(): Promise<Failures> {
    const list: Failures = [];

    // The file's absence is a fault, not a condition. `/codeferret:install-workflow` reads it
    // out of the plugin, the README links to it and `commands/install-workflow.md` names it,
    // and returning here on a missing one left this check and `checkWorkflows` both passing in
    // silence while every one of them broke.
    if (!existsSync(TEMPLATE)) {
        fail(list, TEMPLATE, "is missing, so nothing ships the workflow /codeferret:install-workflow writes");
        return list;
    }

    const template = await Bun.file(TEMPLATE).text();

    // The workflow this repository runs on itself has `uses: ./`. Shipping that shape to
    // somebody else's repository would give them a workflow that resolves to their own
    // checkout.
    if (!/uses:\s*pocketarc\/codeferret@/.test(template)) {
        fail(list, TEMPLATE, "does not use pocketarc/codeferret@<ref>, so it would not run anywhere else");
    }

    const manifest = await pluginManifest(list);
    const released = manifest?.version;
    let named = 0;

    for (const file of [TEMPLATE, "commands/install-workflow.md", "README.md", "CLAUDE.md"]) {
        if (!existsSync(file)) continue;

        for (const [, pinned] of (await Bun.file(file).text()).matchAll(/@v(\d+\.\d+\.\d+)/g)) {
            named += 1;

            if (pinned !== released) {
                fail(list, file, `names @v${pinned}, but ${MANIFEST_FILE} is at ${released}`);
            }
        }
    }

    // A check that matched nothing has proved nothing, and this one used to say nothing
    // either way: no OK line and no failure, so a file that had stopped naming a version read
    // exactly like one that named the right one. Losing the advice above loses the one
    // alternative to `@v1`, so its absence is a failure of its own.
    if (named === 0) {
        fail(list, TEMPLATE, "no shipped file names a @vX.Y.Z to pin, so nothing offers an alternative to @v1");
        return list;
    }

    if (list.length === 0) console.log(`OK versions: ${named} mention(s) of @v${released}`);

    return list;
}
