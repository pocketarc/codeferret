/** What the plugin manifest has to declare before a run can build a plugin from it. */

import { existsSync, statSync } from "node:fs";
import { fail, MANIFEST_FILE, pluginManifest } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkPluginManifest(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await pluginManifest(list);
    if (!manifest) return list;

    if (!manifest.name) fail(list, MANIFEST_FILE, "missing `name`");
    if (!manifest.version) fail(list, MANIFEST_FILE, "missing `version`");
    if (!manifest.description) fail(list, MANIFEST_FILE, "missing `description`");

    // `skills` is absent from the published manifest reference, so a release that stops
    // honouring it would leave every lens unreachable and every review empty.
    const skillsPath = manifest.skills ?? "skills";
    if (!existsSync(skillsPath) || !statSync(skillsPath).isDirectory()) {
        fail(list, MANIFEST_FILE, `\`skills\` points at '${skillsPath}', which is not a directory`);
    }

    // The namespace is not reconciled here. build-prompts.sh reads it out of
    // review/defaults/namespace.txt, which scripts/build-defaults.ts writes from this manifest,
    // and the generated-file check fails when the two differ.

    if (list.length === 0) {
        console.log(`OK ${MANIFEST_FILE}: plugin '${manifest.name}' ${manifest.version}`);
    }
    return list;
}
