#!/usr/bin/env bun
/**
 * Parse every manifest the action and the plugin depend on, and check its shape.
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

// build-prompts.sh hardcodes the namespace for every `codeferret:<lens>` dispatch it
// builds. If that drifts from the manifest, every dispatch names an agent that does not
// exist.
const buildScript = await Bun.file("review/build-prompts.sh").text();
const hardcoded = buildScript.match(/^NAMESPACE=(\S+)$/m)?.[1];

// Only worth comparing when the manifest parsed. Otherwise this reports a namespace
// mismatch and sends the reader to the wrong file.
if (manifest && hardcoded !== namespace) {
    fail("review/build-prompts.sh", `NAMESPACE is '${hardcoded}', but ${manifestFile} declares '${namespace}'`);
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

    // The flag hides the skill from the slash menu, which costs `/codeferret:<lens>` and
    // buys nothing: on 2.1.220 the skill still registers and the model still sees it.
    if (/^user-invocable:\s*false\s*$/m.test(text)) {
        fail(skillFile, "has `user-invocable: false`, which only hides `/codeferret:" + entry.name + "`");
    }

    // Parse it rather than match it. Claude Code's frontmatter parser is lenient enough
    // that an unquoted `: ` in a description loads fine and only breaks wherever
    // something stricter reads it, which is how a cosmetic rewrite of these twelve
    // descriptions turned every one of them into invalid YAML without a word.
    const block = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    let skill: Record<string, unknown> = {};

    if (block === undefined) {
        fail(skillFile, "has no frontmatter");
        continue;
    }

    try {
        skill = (Bun.YAML.parse(block) ?? {}) as Record<string, unknown>;
    } catch (error) {
        fail(skillFile, `frontmatter is not valid YAML: ${error instanceof Error ? error.message : error}`);
        continue;
    }

    // Upstream descriptions are written to get the skill invoked; twelve of them inside
    // a code review tool would fire lenses during unrelated work. prepare-skill.ts
    // rewrites them.
    if (!String(skill.description ?? "").startsWith(`CodeFerret review lens ${entry.name}.`)) {
        fail(skillFile, `description is not scoped — run: bun scripts/prepare-skill.ts ${skillFile} ${entry.name}`);
    }

    const declared = typeof skill.name === "string" ? skill.name.trim() : "";

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

function entries(value: unknown): string[] {
    return String(value ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

for (const lens of entries(action?.inputs?.lenses?.default)) {
    if (!seenSkillNames.has(lens)) {
        fail("action.yml", `default lens '${lens}' has no bundled skill`);
    }
}

// A session cannot read a YAML default, so these lists exist for it to cat. action.yml
// stays the documented default. Entries are compared rather than text, so reindenting
// the block scalar does not fail the build over a non-difference.
for (const [input, file] of [
    ["lenses", "review/defaults/lenses.txt"],
    ["exclude-paths", "review/defaults/exclude-paths.txt"],
] as const) {
    const documented = entries(action?.inputs?.[input]?.default);
    const shipped = entries(await Bun.file(file).text());

    if (documented.join("\n") !== shipped.join("\n")) {
        fail(file, `does not match the \`${input}\` default in action.yml`);
    } else {
        console.log(`✔ ${file} — ${shipped.length} entries, matching action.yml`);
    }
}

// agents/ is generated from review/lens-brief.md, and re-rendering it is the only way
// to catch a hand edit to a generated file.
const agents = Bun.spawnSync(["bun", "scripts/build-lens-agents.ts", "--check"]);
process.stdout.write(new TextDecoder().decode(agents.stdout));

if (agents.exitCode !== 0) {
    process.stderr.write(new TextDecoder().decode(agents.stderr));
    failures += 1;
}

// A command with no description never surfaces in the slash menu, so the feature ships
// and nobody can find it.
// Regexes are what let an unquoted `pull-requests: write` through once already, and a
// command whose frontmatter will not parse never reaches the slash menu at all.
async function checkFrontmatter(file: string, required: string[]): Promise<void> {
    const block = (await Bun.file(file).text()).match(/^---\n([\s\S]*?)\n---\n/)?.[1];

    if (block === undefined) {
        fail(file, "has no frontmatter");
        return;
    }

    let parsed: Record<string, unknown>;
    try {
        parsed = Bun.YAML.parse(block) as Record<string, unknown>;
    } catch (error) {
        fail(file, `frontmatter is not valid YAML: ${error instanceof Error ? error.message : error}`);
        return;
    }

    const missing = required.filter((key) => !parsed?.[key]);
    if (missing.length > 0) fail(file, `frontmatter has no ${missing.map((k) => `\`${k}\``).join(", ")}`);
    else console.log(`✔ ${file}`);
}

for (const entry of existsSync("commands") ? readdirSync("commands") : []) {
    if (entry.endsWith(".md")) await checkFrontmatter(`commands/${entry}`, ["description"]);
}

for (const entry of existsSync("agents") ? readdirSync("agents") : []) {
    if (entry.endsWith(".md")) await checkFrontmatter(`agents/${entry}`, ["name", "description", "tools"]);
}

const workflowFiles = readdirSync(".github/workflows")
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map((entry) => `.github/workflows/${entry}`);

// The template that /codeferret:install-workflow writes sits outside .github/, so
// nothing else parses it, here or on GitHub.
const template = "templates/workflow.yml";
if (existsSync(template)) workflowFiles.push(template);

for (const file of workflowFiles) {
    const workflow = (await parse(file)) as { jobs?: Record<string, unknown> } | null;
    if (!workflow) continue;

    const jobs = Object.keys(workflow.jobs ?? {});
    if (jobs.length === 0) fail(file, "no jobs");
    else console.log(`✔ ${file} — jobs: ${jobs.join(", ")}`);
}

// The workflow this repository runs on itself has `uses: ./`. Shipping that shape to
// somebody else's repository would give them a workflow that resolves to their own
// checkout.
if (existsSync(template) && !/uses:\s*pocketarc\/codeferret@/.test(await Bun.file(template).text())) {
    fail(template, "does not use pocketarc/codeferret@<ref>, so it would not run anywhere else");
}

if (failures > 0) {
    console.error(`\n${failures} problem(s) found.`);
    process.exit(1);
}

console.log("\nall manifests valid");
