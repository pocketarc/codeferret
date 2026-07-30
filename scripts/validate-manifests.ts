#!/usr/bin/env bun
/**
 * Parse action.yml and every workflow, and check the action's shape.
 *
 * GitHub validates workflow syntax when you push, but it does not validate an action
 * manifest until a run tries to load it. A composite action with a YAML error
 * therefore looks fine until it fails at the first step of a real run — which is how
 * an unquoted `pull-requests: write` inside a description shipped once already.
 *
 * Usage: bun scripts/validate-manifests.ts
 */

import { readdirSync } from "node:fs";

let failures = 0;

function fail(file: string, message: string): void {
    console.error(`✘ ${file}: ${message}`);
    failures += 1;
}

async function parse(file: string): Promise<unknown | null> {
    try {
        return Bun.YAML.parse(await Bun.file(file).text());
    } catch (error) {
        fail(file, error instanceof Error ? error.message : String(error));
        return null;
    }
}

const action = (await parse("action.yml")) as {
    name?: string;
    description?: string;
    inputs?: Record<string, { description?: string; required?: boolean; default?: unknown }>;
    runs?: { using?: string; steps?: Array<{ name?: string; shell?: string; uses?: string }> };
} | null;

if (action) {
    if (!action.name) fail("action.yml", "missing `name`");
    if (!action.description) fail("action.yml", "missing `description`");
    if (action.runs?.using !== "composite") {
        fail("action.yml", `runs.using is '${action.runs?.using}', expected 'composite'`);
    }

    const steps = action.runs?.steps ?? [];
    if (steps.length === 0) fail("action.yml", "runs.steps is empty");

    for (const [i, step] of steps.entries()) {
        if (!step.uses && !step.shell) {
            fail("action.yml", `step ${i + 1} (${step.name ?? "unnamed"}) has no \`shell\``);
        }
    }

    for (const [name, input] of Object.entries(action.inputs ?? {})) {
        if (!input.description) fail("action.yml", `input '${name}' has no description`);
        if (input.required === true && input.default !== undefined) {
            fail("action.yml", `input '${name}' is required but also has a default`);
        }
    }

    console.log(
        `✔ action.yml — ${Object.keys(action.inputs ?? {}).length} inputs, ${steps.length} steps`,
    );
}

// One plugin, one namespace: a duplicated name, or one that disagrees with its
// directory, leaves a lens silently unreachable.
const seenSkillNames = new Map<string, string>();

for (const entry of readdirSync("lenses/skills", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillFile = `lenses/skills/${entry.name}/SKILL.md`;
    const text = await Bun.file(skillFile)
        .text()
        .catch(() => null);

    if (text === null) {
        fail(skillFile, "bundled lens has no SKILL.md");
        continue;
    }

    // A skill carrying this flag never registers as a skill, leaving its lens agent
    // with nothing to load.
    if (/^user-invocable:\s*false\s*$/m.test(text)) {
        fail(skillFile, "has `user-invocable: false`, so it will not register as a skill");
    }

    const declared = text.match(/^name:\s*(.+)$/m)?.[1]?.trim();

    if (!declared) {
        fail(skillFile, "no `name` in frontmatter");
    } else if (declared !== entry.name) {
        fail(skillFile, `declares name '${declared}' but its directory is '${entry.name}'`);
    } else if (seenSkillNames.has(declared)) {
        fail(skillFile, `name '${declared}' is already used by ${seenSkillNames.get(declared)}`);
    } else {
        seenSkillNames.set(declared, skillFile);
    }
}

console.log(`✔ lenses/skills — ${seenSkillNames.size} bundled lens(es), names unique`);

for (const lens of String(action?.inputs?.lenses?.default ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    if (!seenSkillNames.has(lens)) {
        fail("action.yml", `default lens '${lens}' has no bundled skill`);
    }
}

const workflowDir = ".github/workflows";
for (const entry of readdirSync(workflowDir)) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;

    const file = `${workflowDir}/${entry}`;
    const workflow = (await parse(file)) as { jobs?: Record<string, unknown> } | null;
    if (!workflow) continue;

    const jobs = Object.keys(workflow.jobs ?? {});
    if (jobs.length === 0) fail(file, "no jobs");
    else console.log(`✔ ${file} — jobs: ${jobs.join(", ")}`);
}

if (failures > 0) {
    console.error(`\n${failures} problem(s) found.`);
    process.exit(1);
}

console.log("\nall manifests valid");
