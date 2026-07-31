#!/usr/bin/env bun
/**
 * Parse every manifest the two front doors depend on, and check its shape.
 *
 * GitHub validates workflow syntax when you push, but it does not validate an action
 * manifest until a run tries to load it. A composite action with a YAML error
 * therefore looks fine until it fails at the first step of a real run — which is how
 * an unquoted `pull-requests: write` inside a description shipped once already.
 *
 * The plugin manifests have the same problem one step further out: Claude Code reads
 * them when somebody installs the plugin, so a broken one fails on their machine.
 *
 * Usage: bun scripts/validate-manifests.ts
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

async function parseJson(file: string): Promise<unknown | null> {
    try {
        return JSON.parse(await Bun.file(file).text());
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

const manifestFile = ".claude-plugin/plugin.json";
const manifest = (await parseJson(manifestFile)) as {
    name?: string;
    version?: string;
    description?: string;
    skills?: string;
} | null;

let namespace = "";

if (manifest) {
    if (!manifest.name) fail(manifestFile, "missing `name`");
    if (!manifest.version) fail(manifestFile, "missing `version`");
    if (!manifest.description) fail(manifestFile, "missing `description`");

    namespace = manifest.name ?? "";

    // `skills` is absent from the published manifest reference, so a release that stops
    // honouring it would leave every lens unreachable and every review empty.
    const skillsPath = manifest.skills ?? "skills";
    if (!existsSync(skillsPath) || !statSync(skillsPath).isDirectory()) {
        fail(manifestFile, `\`skills\` points at '${skillsPath}', which is not a directory`);
    }

    console.log(`✔ ${manifestFile} — plugin '${manifest.name}' ${manifest.version}`);
}

// build-prompts.sh greps this one for the namespace it builds `codeferret:<lens>` refs
// from. Two manifests until the run plugin stops copying it, so they must agree.
const runManifestFile = "lenses/.claude-plugin/plugin.json";
const runManifest = (await parseJson(runManifestFile)) as { name?: string } | null;

if (runManifest && runManifest.name !== namespace) {
    fail(runManifestFile, `declares '${runManifest.name}', but ${manifestFile} declares '${namespace}'`);
}

const marketplaceFile = ".claude-plugin/marketplace.json";
const marketplace = (await parseJson(marketplaceFile)) as {
    name?: string;
    owner?: { name?: string };
    plugins?: Array<{ name?: string; source?: unknown }>;
} | null;

if (marketplace) {
    if (!marketplace.name) fail(marketplaceFile, "missing `name`");
    if (!marketplace.owner?.name) fail(marketplaceFile, "missing `owner.name`");

    const entries = marketplace.plugins ?? [];
    if (entries.length === 0) fail(marketplaceFile, "lists no plugins");

    for (const entry of entries) {
        if (!entry.name) {
            fail(marketplaceFile, "a plugin entry has no `name`");
            continue;
        }
        if (entry.source === undefined) {
            fail(marketplaceFile, `entry '${entry.name}' has no \`source\``);
            continue;
        }
        // A source can also name a git repository or an npm package. Only a path is
        // ours to check.
        if (typeof entry.source !== "string") continue;

        const sourced = join(entry.source, ".claude-plugin/plugin.json");
        if (!existsSync(sourced)) {
            fail(marketplaceFile, `entry '${entry.name}' sources '${entry.source}', which has no plugin.json`);
            continue;
        }

        const target = (await parseJson(sourced)) as { name?: string } | null;
        if (target && target.name !== entry.name) {
            fail(marketplaceFile, `entry '${entry.name}' sources a plugin named '${target.name}'`);
        }
    }

    console.log(`✔ ${marketplaceFile} — marketplace '${marketplace.name}', ${entries.length} plugin(s)`);
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
