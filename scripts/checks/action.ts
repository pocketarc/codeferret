/** The action manifest's own shape: what GitHub needs of it before a run can load it. */

import { action, fail } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkAction(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await action(list);
    if (!manifest) return list;

    if (!manifest.name) fail(list, "action.yml", "missing `name`");
    if (!manifest.description) fail(list, "action.yml", "missing `description`");
    if (manifest.runs?.using !== "composite") {
        fail(list, "action.yml", `runs.using is '${manifest.runs?.using}', expected 'composite'`);
    }

    const steps = manifest.runs?.steps ?? [];
    if (steps.length === 0) fail(list, "action.yml", "runs.steps is empty");

    for (const [i, step] of steps.entries()) {
        if (!step.uses && !step.shell) {
            fail(list, "action.yml", `step ${i + 1} (${step.name ?? "unnamed"}) has no \`shell\``);
        }
    }

    for (const [name, input] of Object.entries(manifest.inputs ?? {})) {
        if (!input.description) fail(list, "action.yml", `input '${name}' has no description`);
        if (input.required === true && input.default !== undefined) {
            fail(list, "action.yml", `input '${name}' is required but also has a default`);
        }
    }

    if (list.length === 0) {
        console.log(`OK action.yml: ${Object.keys(manifest.inputs ?? {}).length} inputs, ${steps.length} steps`);
    }
    return list;
}
