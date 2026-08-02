#!/usr/bin/env bun
/**
 * Parse every manifest the action and the plugin depend on, and check its shape.
 *
 * GitHub validates workflow syntax when you push, but it does not validate an action
 * manifest until a run tries to load it. A composite action with a YAML error
 * therefore looks fine until it fails at the first step of a real run. That is how an
 * unquoted `pull-requests: write` inside a description shipped once already.
 *
 * The plugin manifests have the same problem one step further out: Claude Code reads
 * them when somebody installs the plugin, so a broken one fails on their machine.
 *
 * Each check below is a named function returning its failures, and CHECKS is the list.
 * The file used to be one run of top-level statements threaded on a shared counter, and
 * there was no way to see what it covered without reading all of it.
 *
 * Usage: bun scripts/validate-manifests.ts [<check-name>...]
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every path below is repository-relative, and whoever has just edited this script is
// standing in scripts/. Without this the run dies on a raw ENOENT instead of checking
// anything.
process.chdir(join(import.meta.dir, ".."));

type Failures = string[];

function fail(list: Failures, file: string, message: string): void {
    list.push(`${file}: ${message}`);
}

async function parseYaml(list: Failures, file: string): Promise<unknown | null> {
    try {
        return Bun.YAML.parse(await Bun.file(file).text());
    } catch (error) {
        fail(list, file, error instanceof Error ? error.message : String(error));
        return null;
    }
}

async function parseJson(list: Failures, file: string): Promise<unknown | null> {
    try {
        return JSON.parse(await Bun.file(file).text());
    } catch (error) {
        fail(list, file, error instanceof Error ? error.message : String(error));
        return null;
    }
}

/**
 * A markdown file's YAML frontmatter.
 *
 * Parsed rather than matched. Claude Code's frontmatter parser is lenient enough that an
 * unquoted `: ` in a description loads fine and only breaks wherever something stricter
 * reads it, which is how a cosmetic rewrite of every bundled description turned each one
 * into invalid YAML without a word.
 */
async function frontmatter(
    list: Failures,
    file: string,
): Promise<Record<string, unknown> | null> {
    const block = (await Bun.file(file).text()).match(/^---\n([\s\S]*?)\n---\n/)?.[1];

    if (block === undefined) {
        fail(list, file, "has no frontmatter");
        return null;
    }

    try {
        return (Bun.YAML.parse(block) ?? {}) as Record<string, unknown>;
    } catch (error) {
        fail(list, file, `frontmatter is not valid YAML: ${error instanceof Error ? error.message : error}`);
        return null;
    }
}

/** A newline-separated action.yml default, as trimmed lines. */
function lines(value: unknown): string[] {
    return String(value ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

interface Action {
    name?: string;
    description?: string;
    inputs?: Record<string, { description?: string; required?: boolean; default?: unknown }>;
    runs?: {
        using?: string;
        steps?: Array<{ name?: string; shell?: string; uses?: string; run?: string }>;
    };
}

let cachedAction: Action | null | undefined;

async function action(list: Failures): Promise<Action | null> {
    if (cachedAction === undefined) cachedAction = (await parseYaml(list, "action.yml")) as Action | null;
    return cachedAction;
}

async function checkAction(): Promise<Failures> {
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

    console.log(`OK action.yml: ${Object.keys(manifest.inputs ?? {}).length} inputs, ${steps.length} steps`);
    return list;
}

async function checkActionShell(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await action(list);
    if (!manifest) return list;

    // A machine without shellcheck prints a line and skips the check: this script is what
    // a maintainer runs before pushing, and CI has the linter.
    if (!Bun.which("shellcheck")) {
        console.log("-- action.yml: no shellcheck on PATH, its shell steps went unchecked");
        return list;
    }

    const steps = (manifest.runs?.steps ?? []).filter((step) => step.shell === "bash" && step.run);

    // A fresh directory per run, because a predictable name under a shared /tmp is one
    // another local user can pre-create as a symlink onto a file this then overwrites.
    const dir = mkdtempSync(join(tmpdir(), "codeferret-"));

    try {
        for (const [i, step] of steps.entries()) {
            const name = step.name ?? "unnamed";
            const file = join(dir, `step-${i + 1}.sh`);
            await Bun.write(file, `#!/usr/bin/env bash\n${step.run}`);

            // SC2016 for the same reason the workflow passes it: these blocks printf
            // markdown, and a backtick in a single-quoted format is not an expansion.
            const run = Bun.spawnSync(["shellcheck", "-e", "SC2016", file]);
            if (run.exitCode !== 0) {
                fail(list, "action.yml", `shellcheck on step '${name}':\n${new TextDecoder().decode(run.stdout)}`);
            }
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(`OK action.yml: ${steps.length} shell step(s) pass shellcheck`);
    return list;
}

const MANIFEST_FILE = ".claude-plugin/plugin.json";

let cachedManifest: { name?: string; version?: string; description?: string; skills?: string } | null | undefined;

async function pluginManifest(list: Failures) {
    if (cachedManifest === undefined) {
        cachedManifest = (await parseJson(list, MANIFEST_FILE)) as typeof cachedManifest;
    }
    return cachedManifest;
}

async function checkPluginManifest(): Promise<Failures> {
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

async function checkMarketplace(): Promise<Failures> {
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

let cachedBundled: Set<string> | undefined;

/**
 * The lenses this repository bundles: a directory under lenses/skills holding a SKILL.md.
 *
 * Read from the tree rather than filled in as a side effect of another check. Any check
 * can be named on its own, and `provenance` alone once reported all fourteen bundled
 * lenses as missing because the check that populated the set had not run.
 */
function bundledLenses(): Set<string> {
    if (cachedBundled === undefined) {
        cachedBundled = new Set(
            readdirSync("lenses/skills", { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && existsSync(`lenses/skills/${entry.name}/SKILL.md`))
                .map((entry) => entry.name),
        );
    }

    return cachedBundled;
}

async function checkBundledSkills(): Promise<Failures> {
    const list: Failures = [];

    // One plugin, one namespace: a duplicated name, or one that disagrees with its
    // directory, leaves a lens silently unreachable.
    const seen = new Map<string, string>();

    for (const entry of readdirSync("lenses/skills", { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const skillFile = `lenses/skills/${entry.name}/SKILL.md`;

        if (!existsSync(skillFile)) {
            fail(list, skillFile, "bundled lens has no SKILL.md");
            continue;
        }

        const skill = await frontmatter(list, skillFile);
        if (!skill) continue;

        // The flag hides the skill from the slash menu, which costs `/codeferret:<lens>`
        // and buys nothing: on 2.1.220 the skill still registers and the model still sees
        // it.
        if (skill["user-invocable"] === false) {
            fail(list, skillFile, `has \`user-invocable: false\`, which only hides \`/codeferret:${entry.name}\``);
        }

        // A lens agent loads its skill through the Skill tool, which counts as model
        // invocation. Left in, this flag costs one lens with nothing to say about it.
        if (skill["disable-model-invocation"] === true) {
            fail(list, skillFile, "has `disable-model-invocation: true`, so no lens agent could load it");
        }

        // Upstream writes a description to get the skill invoked, and a whole set of them
        // inside a code review tool would fire lenses during unrelated work.
        // prepare-skill.ts rewrites them.
        if (!String(skill.description ?? "").startsWith(`CodeFerret review lens ${entry.name}.`)) {
            fail(list, skillFile, `description is not scoped. Run: bun scripts/prepare-skill.ts ${skillFile} ${entry.name}`);
        }

        const declared = typeof skill.name === "string" ? skill.name.trim() : "";

        if (!declared) fail(list, skillFile, "no `name` in frontmatter");
        else if (declared !== entry.name) {
            fail(list, skillFile, `declares name '${declared}' but its directory is '${entry.name}'`);
        } else if (seen.has(declared)) {
            fail(list, skillFile, `name '${declared}' is already used by ${seen.get(declared)}`);
        } else seen.set(declared, skillFile);
    }

    console.log(`OK lenses/skills: ${seen.size} bundled lens(es), names unique`);
    return list;
}

async function checkProvenance(): Promise<Failures> {
    const list: Failures = [];
    const file = "lenses/skills/PROVENANCE.tsv";

    if (!existsSync(file)) {
        fail(list, file, "is missing, so nothing records where the bundled lenses came from");
        return list;
    }

    const recorded = new Set(
        (await Bun.file(file).text())
            .split("\n")
            .slice(1)
            .map((line) => (line.split("\t")[0] ?? "").trim())
            .filter(Boolean),
    );

    const bundled = bundledLenses();

    for (const lens of bundled) {
        if (!recorded.has(lens)) fail(list, file, `has no row for bundled lens '${lens}'`);
    }

    for (const lens of recorded) {
        if (!bundled.has(lens)) fail(list, file, `records '${lens}', which is not bundled`);
    }

    console.log(`OK ${file}: ${recorded.size} row(s), one per bundled lens`);
    return list;
}

async function checkDefaults(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await action(list);
    if (!manifest) return list;

    for (const lens of lines(manifest.inputs?.lenses?.default)) {
        if (!existsSync(`lenses/skills/${lens}/SKILL.md`)) {
            fail(list, "action.yml", `default lens '${lens}' has no bundled skill`);
        }
    }

    // A tool named by default and missing from review/tools/ fails every run at the point
    // it is invoked, which is after the checkout and before anything useful has happened.
    const tools = lines(manifest.inputs?.tools?.default);

    for (const tool of tools) {
        if (!existsSync(`review/tools/${tool}.ts`)) {
            fail(list, "action.yml", `default tool '${tool}' has no review/tools/${tool}.ts`);
        }
    }

    // Tools report to one lens and to nothing else, and review/lib.sh is where that lens
    // is named. Defaulting the tools on without it means running them and throwing the
    // reports away.
    const toolsLens = (await Bun.file("review/lib.sh").text()).match(/^export TOOLS_LENS=(\S+)$/m)?.[1];

    if (!toolsLens) {
        fail(list, "review/lib.sh", "declares no TOOLS_LENS, so nothing says which lens reads the tool reports");
    } else if (tools.length > 0 && !lines(manifest.inputs?.lenses?.default).includes(toolsLens)) {
        fail(list, "action.yml", `tools run by default but '${toolsLens}' is not a default lens, so nothing reads them`);
    }

    console.log("OK action.yml: every default lens and tool exists");
    return list;
}

async function checkGenerated(): Promise<Failures> {
    const list: Failures = [];

    // Both directories are generated, and re-running the generator is the only way to
    // catch a hand edit to a file it owns.
    for (const generator of ["scripts/build-lens-agents.ts", "scripts/build-defaults.ts"]) {
        const run = Bun.spawnSync(["bun", generator, "--check"]);
        process.stdout.write(new TextDecoder().decode(run.stdout));

        if (run.exitCode !== 0) {
            list.push(new TextDecoder().decode(run.stderr).trim());
        }
    }

    return list;
}

async function checkPrompts(): Promise<Failures> {
    const list: Failures = [];

    // A command whose frontmatter will not parse, or that has no description, never shows
    // up in the slash menu: the feature ships and nobody can find it.
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

const TEMPLATE = "templates/workflow.yml";

async function checkWorkflows(): Promise<Failures> {
    const list: Failures = [];
    const dir = ".github/workflows";

    const files = (existsSync(dir) ? readdirSync(dir) : [])
        .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
        .map((entry) => `${dir}/${entry}`);

    if (files.length === 0) fail(list, dir, "holds no workflow");

    // The template that /codeferret:install-workflow writes sits outside .github/, so
    // nothing else parses it, here or on GitHub.
    if (existsSync(TEMPLATE)) files.push(TEMPLATE);

    const gates = new Map<string, string>();

    for (const file of files) {
        const workflow = (await parseYaml(list, file)) as { jobs?: Record<string, { if?: string }> } | null;
        if (!workflow) continue;

        const jobs = Object.keys(workflow.jobs ?? {});
        if (jobs.length === 0) fail(list, file, "no jobs");
        else console.log(`OK ${file}: jobs ${jobs.join(", ")}`);

        const gate = workflow.jobs?.review?.if;
        if (typeof gate === "string") gates.set(file, gate.replace(/\s+/g, " ").trim());
    }

    // The template ships the gate this repository runs on itself, and the reasoning for
    // all three of its clauses lives only in the template. Tightened in one file and not
    // the other, either this repository reviews pull requests it decided not to, or every
    // consumer who installed the template does.
    const own = `${dir}/codeferret.yml`;

    if (gates.has(own) && gates.has(TEMPLATE) && gates.get(own) !== gates.get(TEMPLATE)) {
        fail(list, TEMPLATE, `jobs.review.if does not match ${own}`);
    }

    return list;
}

async function checkShippedVersions(): Promise<Failures> {
    const list: Failures = [];
    if (!existsSync(TEMPLATE)) return list;

    const template = await Bun.file(TEMPLATE).text();

    // The workflow this repository runs on itself has `uses: ./`. Shipping that shape to
    // somebody else's repository would give them a workflow that resolves to their own
    // checkout.
    if (!/uses:\s*pocketarc\/codeferret@/.test(template)) {
        fail(list, TEMPLATE, "does not use pocketarc/codeferret@<ref>, so it would not run anywhere else");
    }

    // Each of these tells a consumer which version tag to pin instead of the mutable
    // `@v1`, and two of them named a tag that never existed. Following that advice fails
    // the job at load with "unable to find version", which is the one escape hatch from a
    // mutable tag. The release procedure moves the tag and `version` together, so the
    // manifest is what they have to agree with.
    const manifest = await pluginManifest(list);
    const released = manifest?.version;

    for (const file of [TEMPLATE, "commands/install-workflow.md", "README.md", "CLAUDE.md"]) {
        if (!existsSync(file)) continue;

        for (const [, named] of (await Bun.file(file).text()).matchAll(/@v(\d+\.\d+\.\d+)/g)) {
            if (named !== released) {
                fail(list, file, `names @v${named}, but ${MANIFEST_FILE} is at ${released}`);
            }
        }
    }

    return list;
}

const CHECKS: Array<[string, () => Promise<Failures>]> = [
    ["action", checkAction],
    ["action-shell", checkActionShell],
    ["plugin", checkPluginManifest],
    ["marketplace", checkMarketplace],
    ["skills", checkBundledSkills],
    ["provenance", checkProvenance],
    ["defaults", checkDefaults],
    ["generated", checkGenerated],
    ["prompts", checkPrompts],
    ["workflows", checkWorkflows],
    ["versions", checkShippedVersions],
];

const named = process.argv.slice(2);
const unknown = named.filter((name) => !CHECKS.some(([check]) => check === name));

if (unknown.length > 0) {
    console.error(`no such check: ${unknown.join(", ")}`);
    console.error(`checks: ${CHECKS.map(([name]) => name).join(", ")}`);
    process.exit(2);
}

const failures: Failures = [];

for (const [name, check] of CHECKS) {
    if (named.length > 0 && !named.includes(name)) continue;
    failures.push(...(await check()));
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`\n${failures.length} problem(s) found.`);
    process.exit(1);
}

console.log("\nall manifests valid");
