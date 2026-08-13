#!/usr/bin/env bun
/**
 * Every check on this repository that needs no findings file to run.
 *
 * Each manifest the action and the plugin depend on is parsed and its shape checked, along
 * with the values two files have to agree on: the plugin namespace, the shipped version, the
 * defaults, the standing caveats, and everything generated. Both generators are re-run with
 * `--check`, and action.yml's `run:` blocks go through shellcheck, being the only shell in
 * the repository that lives as a string inside YAML.
 *
 * A value with one authority belongs in a generator instead, and two of these checks were
 * deleted by moving one value there. What is left is the pairs where neither side can be
 * derived from the other: a literal in shell against a literal in JSON, a version in prose
 * against the manifest.
 *
 * Nothing upstream catches any of this before somebody feels it. "Before you push" in
 * CLAUDE.md has what a broken manifest costs and what to do about it.
 *
 * Usage: bun scripts/validate-repo.ts [<check-name>...]
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reason, record } from "../review/json.ts";
import { closeOpenFence } from "../review/markdown.ts";
import { STANDING_DETAIL } from "../review/standing-detail.ts";
import { dispatchedFrom, LENS_LIST_FILE, RUN_FILE_NAMES, RUN_FILES } from "../review/run-files.ts";

process.chdir(join(import.meta.dir, ".."));

type Failures = string[];

function fail(list: Failures, file: string, message: string): void {
    list.push(`${file}: ${message}`);
}

async function parseYaml(list: Failures, file: string): Promise<unknown | null> {
    try {
        return Bun.YAML.parse(await Bun.file(file).text());
    } catch (error) {
        fail(list, file, reason(error));
        return null;
    }
}

async function parseJson(list: Failures, file: string): Promise<unknown | null> {
    try {
        return JSON.parse(await Bun.file(file).text());
    } catch (error) {
        fail(list, file, reason(error));
        return null;
    }
}

/**
 * A markdown file's YAML frontmatter.
 *
 * Parsed rather than matched. Claude Code's frontmatter parser is lenient enough that an
 * unquoted `: ` in a description loads fine and only breaks wherever something stricter
 * reads it, with nothing said in between.
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
        fail(list, file, `frontmatter is not valid YAML: ${reason(error)}`);
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

/**
 * A manifest parsed once, however many checks ask for it.
 *
 * The `Failures` list belongs to whichever check asked first, so a parse failure is
 * reported once rather than on every check that reads the file. Every one of them returns
 * early on a null, so nothing carries on as though the file had parsed.
 */
function parsedOnce<T>(load: (list: Failures) => Promise<T | null>): (list: Failures) => Promise<T | null> {
    let held: { value: T | null } | undefined;

    return async (list) => {
        if (!held) held = { value: await load(list) };

        return held.value;
    };
}

const action = parsedOnce<Action>(async (list) => (await parseYaml(list, "action.yml")) as Action | null);

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
            //
            // `-x` with the repository root as the source path, because a step is written
            // out to a temporary file and a `# shellcheck source=` directive in it would
            // otherwise resolve nowhere. The steps that source review/lib.sh for the helper
            // that writes their outputs are the ones the check exists to cover.
            const run = Bun.spawnSync(["shellcheck", "-e", "SC2016", "-x", `--source-path=${process.cwd()}`, file]);
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

interface PluginManifest {
    name?: string;
    version?: string;
    description?: string;
    skills?: string;
}

const pluginManifest = parsedOnce<PluginManifest>(
    async (list) => (await parseJson(list, MANIFEST_FILE)) as PluginManifest | null,
);

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

/**
 * The lenses this repository bundles: a directory under lenses/skills holding a SKILL.md.
 *
 * Read from the tree rather than filled in as a side effect of another check, because any
 * check here can be named on its own and run alone.
 */
function bundledLenses(): Set<string> {
    return new Set(
        readdirSync("lenses/skills", { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(`lenses/skills/${entry.name}/SKILL.md`))
            .map((entry) => entry.name),
    );
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

        // On 2.1.220 the flag only hides the skill from the slash menu: Claude Code still
        // registers it and the model still sees it.
        if (skill["user-invocable"] === false) {
            fail(list, skillFile, `has \`user-invocable: false\`, which only hides \`/codeferret:${entry.name}\``);
        }

        // A lens agent loads its skill through the Skill tool, which counts as model
        // invocation. Left in, the lens loads no skill and returns nothing.
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

/**
 * That every vendored markdown file's fences balance.
 *
 * A closing fence may be indented up to three spaces and need not match its opener's length,
 * so a nested sample closes the template it is nested in. From there the reading is inverted:
 * what was meant as the template renders as live markdown, and the delimiter meant to close
 * it opens a block nothing closes, so the rest of the page is one grey box. Two of the
 * bundled skills arrived that way and neither was noticed for as long as it took a lens to
 * read one.
 *
 * The rendering is the smaller half. `rewrite-markdown.ts` skips every line `fenceMap` calls
 * fenced, so a swallowed tail is a region `stripDeadLinks` and `substitutePlaceholders` never
 * reach, and a `../` link or a `$ARGUMENTS` there survives into the lens's own instructions.
 *
 * Refused rather than repaired. A repair has to guess which delimiter was meant as the
 * closer, and an attempt at it settled one of these two files onto the wrong opener and
 * swallowed the whole document. What the fix takes is raising the enclosing fence, and a
 * person with the upstream page in front of them can see which one that is. So the
 * correction is a deliberate edit to the vendored file, and this check is what stops a
 * re-vendor dropping it in silence.
 */
async function checkSkillFences(): Promise<Failures> {
    const list: Failures = [];
    const root = "lenses/skills";
    let checked = 0;

    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        for (const name of readdirSync(join(root, entry.name), { recursive: true }) as string[]) {
            if (!name.endsWith(".md")) continue;

            const file = join(root, entry.name, name);
            const text = await Bun.file(file).text();
            checked += 1;

            // `closeOpenFence` hands back what it was given when nothing is open, so the
            // comparison is the balance test and there is no second reading of the fences.
            if (closeOpenFence(text) !== text) {
                fail(list, file, "ends inside a fenced block, so a nested fence closed one it was meant to sit in");
            }
        }
    }

    if (list.length === 0) console.log(`OK lenses/skills: ${checked} markdown file(s) with balanced fences`);

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

    const lenses = lines(manifest.inputs?.lenses?.default);

    for (const lens of lenses) {
        if (!existsSync(`lenses/skills/${lens}/SKILL.md`)) {
            fail(list, "action.yml", `default lens '${lens}' has no bundled skill`);
        }
    }

    console.log("OK action.yml: every default lens has a bundled skill");
    return list;
}

/**
 * What this repository's own workflow says about the lenses it runs.
 *
 * It used to restate the shipped default minus two, which nothing could keep in step: a lens
 * removed from action.yml and left there failed `build-prompts.sh` seconds into a run, and a
 * lens *added* to action.yml and not there was silent for ever, the review covering less than
 * the default and saying nothing about it. Forty lines here reconciled the copy in both
 * directions against a map naming the two exceptions.
 *
 * `exclude-lenses` states the intent instead, and subtraction cannot go stale when the
 * default grows. What is left to check is that the workflow has not gone back to a copy, and
 * that each name it subtracts is one action.yml still ships: a stale exclusion runs a lens
 * this repository decided not to run, and `run.sh` only says so on the job's stderr.
 */
async function checkWorkflowLenses(): Promise<Failures> {
    const list: Failures = [];
    const path = ".github/workflows/codeferret.yml";
    const manifest = await action(list);
    if (!manifest) return list;

    const parsed = record(await parseYaml(list, path));
    const job = record(record(parsed?.jobs)?.review);
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const shipped = lines(manifest.inputs?.lenses?.default);

    for (const step of steps) {
        const to = record(record(step)?.with);

        if (lines(to?.lenses).length > 0) {
            fail(list, path, "names `lenses`, which replaces the default. Subtract with `exclude-lenses` instead.");
        }

        for (const lens of lines(to?.["exclude-lenses"])) {
            if (!shipped.includes(lens)) {
                fail(list, path, `excludes '${lens}', which action.yml no longer ships. Drop it, or fix the name.`);
            }
        }
    }

    const dropped = steps.flatMap((step) => lines(record(record(step)?.with)?.["exclude-lenses"]));

    if (list.length === 0) console.log(`OK ${path}: the shipped default minus ${dropped.length}`);

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

/**
 * Whether check-findings.ts still names fields merged-schema.json has.
 *
 * A rule naming a field the schema no longer has stops running, and check-findings.ts then
 * reports `shape valid` for a file that rule would have caught. The question is answerable
 * without a review, and asking it at the end of one would throw a review away to report a
 * typo here.
 */
async function checkFindingRules(): Promise<Failures> {
    const list: Failures = [];
    const run = Bun.spawnSync(["bun", "review/check-findings.ts", "--self-check"]);
    const decode = new TextDecoder();

    if (run.exitCode !== 0) list.push(decode.decode(run.stderr).trim());
    else process.stdout.write(decode.decode(run.stdout));

    return list;
}

/**
 * The standing caveats in review-body.ts, against the lenses they name.
 *
 * A key that names no lens fails in the dangerous direction and in silence: `caveatOf`
 * gives nothing back, the lens drops out of `limited`, the `[!NOTE]` above the health list
 * stops counting it, and the review renders as though the interface had been checked from a
 * rendered page. No error, no warning, and every other check here still passes.
 *
 * The same class as a misnamed `review/lens-extras/<lens>.md`, which build-lens-agents.ts
 * guards for the same reason. Lens names here do get added, renamed and removed.
 */
async function checkStandingDetail(): Promise<Failures> {
    const list: Failures = [];
    const file = "review/standing-detail.ts";

    // The map is generated from the `standing-detail` frontmatter of the extras files, and
    // checkGenerated re-runs that generator, so drift between the two is already covered.
    // What is left is the case the generator cannot see: every lens whose extras open by
    // naming a capability the session does not have should claim a sentence, and an empty
    // map means a review promises a caveat nobody wrote.
    if (STANDING_DETAIL.size === 0) {
        fail(list, file, "holds no caveat, so a review says nothing about what a lens could not reach");
        return list;
    }

    const bundled = bundledLenses();

    for (const lens of STANDING_DETAIL.keys()) {
        if (!bundled.has(lens)) {
            fail(list, file, `names '${lens}', which is not a lens under lenses/skills/`);
        }
    }

    if (list.length === 0) {
        console.log(`OK standing-detail: every caveat names a bundled lens`);
    }

    return list;
}

/**
 * The run files action.yml reads back, against the names the scripts write them under.
 *
 * action.yml cannot import `RUN_FILES`, so its `emit_output_file` calls spell each name out
 * a second time. Rename one side and the summary and the step outputs report `unknown` for a
 * $36 review, which is exactly what a session killed halfway looks like.
 *
 * Not a pair a generator could collapse, which is what became of the artifact name and the
 * retention window. YAML cannot read a TypeScript constant, and the shell that would write
 * one of these into a step output is the shell inside action.yml.
 */
async function checkRunFiles(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await action(list);
    if (!manifest) return list;

    const shell = (manifest.runs?.steps ?? []).map((step) => step.run ?? "").join("\n");
    const named = [...shell.matchAll(/^\s*emit_output_file\s+(\S+)\s+"\$out\/(\S+?)"/gm)];

    if (named.length === 0) {
        fail(list, "action.yml", "makes no `emit_output_file` call, so no run file reaches a step output");
        return list;
    }

    for (const [, output, file] of named) {
        if (!RUN_FILE_NAMES.includes(String(file))) {
            fail(list, "action.yml", `output '${output}' reads '${file}', which review/run-files.ts does not name`);
        }
    }

    // `findings-checked` is the one run file no TypeScript writes, so the shell is its only
    // other home. Drift here is the quietest failure the action has: the marker goes down
    // under a name the posting step's condition does not test, so a review is produced, paid
    // for, and never posted, with nothing red anywhere.
    for (const script of ["review/run.sh", "review/local-post.sh"]) {
        if (!(await Bun.file(script).text()).includes(RUN_FILES.findingsChecked)) {
            fail(list, script, `never names '${RUN_FILES.findingsChecked}', which is what the action posts on`);
        }
    }

    if (list.length === 0) console.log(`OK run-files: ${named.length} step output(s) name a file the run writes`);

    return list;
}

/**
 * Every `bun` a review starts, against the flag that keeps the reviewed tree out of it.
 *
 * Bun runs the `preload` script named by the `bunfig.toml` in its working directory, before
 * the script on the command line. A review stands in the checkout it is reviewing, and the
 * orchestrator has `Bash` under `bypassPermissions` and knows every other directory a run
 * uses, so moving out of the tree only moves the problem. `--config=/dev/null` is the whole
 * control, and it is one flag to forget in a job holding `CLAUDE_CODE_OAUTH_TOKEN` and a
 * token that can write to pull requests.
 *
 * A printed hint counts. Whoever pastes one is standing where the run left them.
 *
 * Not lint.yml or lefthook.yml: both run over a checkout of this repository, and lint.yml's
 * fork job holds no secrets and no write permissions, which is why it may run a fork's tests
 * at all.
 */
async function checkBunConfig(): Promise<Failures> {
    const list: Failures = [];

    // Both script directories, not just review/. `scripts/vendor-lens.sh` runs bun too, and
    // being outside the scanned set is how its invocation went without the flag.
    const shell = ["review", "scripts"].flatMap((dir) =>
        readdirSync(dir)
            .filter((f) => f.endsWith(".sh"))
            .map((f) => `${dir}/${f}`),
    );

    const files = [...shell, "action.yml"];
    let invocations = 0;

    for (const file of files) {
        // Line continuations joined first. Every long invocation in these scripts is written
        // over several lines with a trailing backslash, and a per-line match sees the flag
        // and the script name as two unrelated fragments: `bun \` matched nothing at all, so
        // the ones most worth checking were the ones being skipped.
        const text = (await Bun.file(file).text()).replace(/\\\n\s*/g, " ");

        for (const [, flags, script] of text.matchAll(/\bbun\b([^\n]*?)([\w$"'{}/.-]*\.ts)\b/g)) {
            invocations += 1;

            if (!String(flags).includes("--config=")) {
                fail(list, file, `runs \`bun ... ${script}\` with no --config=/dev/null`);
            }
        }
    }

    // A check that matched nothing has proved nothing. This is the only mechanical guard on
    // the rule, in a job holding both tokens, so silence here has to be a failure rather than
    // an OK line: a regex that stops matching would otherwise read exactly like compliance.
    if (invocations === 0) {
        fail(list, "scripts/validate-repo.ts", "checkBunConfig matched no bun invocation at all, so it checked nothing");
    }

    if (list.length === 0) console.log(`OK bun-config: ${invocations} bun invocation(s) name a config`);

    return list;
}

/**
 * The lens list build-prompts.sh writes, against the pattern that reads it back.
 *
 * Two languages, one line format, and drift is silent in the direction that matters: a
 * changed line leaves `dispatchedFrom` returning nothing, `coverageOf` stops reporting a
 * lens that ran and said nothing about itself, and check-findings.ts goes on printing
 * `shape valid`.
 *
 * The shell's own line is run rather than matched, because a format matched by a second
 * pattern is a third spelling to keep in step.
 */
async function checkLensList(): Promise<Failures> {
    const list: Failures = [];
    const script = "review/build-prompts.sh";
    const shell = await Bun.file(script).text();

    // The format is read out and rendered here rather than run. An earlier version of this
    // check pulled the line out with a loose pattern and handed it to `bash -c`, so a branch
    // whose build-prompts.sh read `printf x; curl … | sh >>"$BUILD/lens-list.txt"` had that
    // line executed on the machine of whoever checked the branch out, by a lefthook hook, on
    // commit. Nothing about a validator needs to run the shell it is validating: what the two
    // sides have to agree on is the format string, and the format string can be read.
    const named = LENS_LIST_FILE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const writes = new RegExp(
        String.raw`^\s*printf (?:-- )?'([^']*)' "\$NAMESPACE" "\$lens" >>"\$BUILD/${named}"$`,
        "m",
    );
    const format = shell.match(writes)?.[1];

    if (format === undefined) {
        fail(
            list,
            script,
            `has no line appending to ${LENS_LIST_FILE} in the shape this check reads:` +
                ` one printf with a quoted format, "$NAMESPACE" and "$lens"`,
        );
        return list;
    }

    // printf, for the two conversions this format is allowed to use. A format reaching for
    // anything else is refused rather than guessed at, because a check that renders a
    // format differently from the shell proves nothing about the shell.
    const directives = format.match(/%./g) ?? [];

    if (directives.length !== 2 || directives.some((d) => d !== "%s")) {
        fail(list, script, `its ${LENS_LIST_FILE} format uses ${directives.join(" ")}, and this check renders %s only`);
        return list;
    }

    const rendered = format
        .replace(/%s/, "codeferret")
        .replace(/%s/, "example-lens")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\");

    const read = dispatchedFrom(rendered);

    if (read.length !== 1 || read[0] !== "codeferret:example-lens") {
        fail(
            list,
            "review/run-files.ts",
            `LENS_LIST_LINE reads ${JSON.stringify(read)} out of ${JSON.stringify(rendered)},` +
                ` which is what ${script} writes`,
        );
        return list;
    }

    console.log(`OK lens-list: ${script} and review/run-files.ts agree on the line format`);

    return list;
}

/**
 * That the two places bun is installed both take the version out of review/versions.sh.
 *
 * Both pin it because both would otherwise run a fork's code under an unpinned global
 * install. It used to be pinned twice with a comment asking for one edit, which this file
 * reconciled; one home needs no reconciling, and what is worth guarding instead is the way
 * back to two. That way is a literal typed into either caller, and the cost of it is quiet:
 * the tests pass under one bun and the review runs under another.
 *
 * Matching no literal is the passing case here, so this check has no empty-match hole. What
 * carries the weight is the positive half above it, which fails on a caller that stopped
 * reading the file.
 */
async function checkToolchainPin(): Promise<Failures> {
    const list: Failures = [];
    const home = "review/versions.sh";
    const declared = (await Bun.file(home).text()).match(/^export BUN_VERSION=(\S+)$/m)?.[1];

    if (!declared) {
        fail(list, home, "declares no BUN_VERSION, so nothing pins the bun a review runs on");
        return list;
    }

    for (const file of ["action.yml", ".github/workflows/lint.yml"]) {
        const text = await Bun.file(file).text();

        if (!text.includes(home)) {
            fail(list, file, `installs bun without reading ${home}, so its version can drift again`);
            continue;
        }

        for (const [, pinned] of text.matchAll(/\bbun@([^"'\s]+)/g)) {
            if (!String(pinned).startsWith("$")) {
                fail(list, file, `pins bun@${pinned} of its own, and ${home} is where that lives`);
            }
        }
    }

    if (list.length === 0) console.log(`OK toolchain: both installs read bun@${declared} from ${home}`);

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

    // The template ships the gate this repository runs on itself, and the reasoning for that
    // gate lives only in the template. Tighten it in one file and not the other, and either
    // this repository reviews pull requests it decided not to, or every consumer who
    // installed the template does.
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

    // Each of these tells a consumer which version tag to pin instead of the mutable `@v1`,
    // which is the one escape hatch from that tag. Advice naming a tag nobody cut fails the
    // job at load with "unable to find version". The release procedure moves the tag and
    // `version` together, so the manifest is what they have to agree with.
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

const CHECKS: Array<[string, () => Promise<Failures>]> = [
    ["action", checkAction],
    ["action-shell", checkActionShell],
    ["plugin", checkPluginManifest],
    ["marketplace", checkMarketplace],
    ["skills", checkBundledSkills],
    ["skill-fences", checkSkillFences],
    ["provenance", checkProvenance],
    ["defaults", checkDefaults],
    ["workflow-lenses", checkWorkflowLenses],
    ["generated", checkGenerated],
    ["finding-rules", checkFindingRules],
    ["run-files", checkRunFiles],
    ["lens-list", checkLensList],
    ["bun-config", checkBunConfig],
    ["toolchain", checkToolchainPin],
    ["standing-detail", checkStandingDetail],
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

console.log("\nevery check passes");
