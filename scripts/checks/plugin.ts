/** The plugin manifest, and the one value build-prompts.sh spells out a second time. */

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

    // build-prompts.sh hardcodes the namespace for every `codeferret:<lens>` dispatch it
    // builds. If that drifts from the manifest, every dispatch names an agent that does
    // not exist.
    const script = await Bun.file("review/build-prompts.sh").text();
    const hardcoded = script.match(/^NAMESPACE=(\S+)$/m)?.[1];

    if (hardcoded !== manifest.name) {
        fail(list, "review/build-prompts.sh", `NAMESPACE is '${hardcoded}', but ${MANIFEST_FILE} declares '${manifest.name}'`);
    }

    console.log(`OK ${MANIFEST_FILE}: plugin '${manifest.name}' ${manifest.version}`);
    return list;
}
