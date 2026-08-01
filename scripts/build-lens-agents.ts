#!/usr/bin/env bun
/**
 * Render the lens agent definitions the plugin ships.
 *
 * A plugin's agents load when the session starts, so they cannot be written per run the
 * way the action writes them into RUNNER_TEMP. The base ref and the pathspec are what
 * varies per run, and both live in the dispatch prompt (review/lens-dispatch.md)
 * instead. That leaves the skill name and the output schema, which are fixed per lens.
 *
 * Everything in agents/ is generated from review/lens-brief.md by this script. Run it
 * after editing that file; validate-manifests.ts re-runs it with --check and fails when
 * the checked-in agents have drifted.
 *
 * Usage: bun scripts/build-lens-agents.ts [--check]
 */

import { existsSync, readdirSync } from "node:fs";

// No Write, Edit or NotebookEdit, matching what the action denies at the CLI. Naming the
// set rather than subtracting from it also leaves out every MCP tool, which a diff
// review has no use for and which the action drops with --strict-mcp-config.
//
// A tool name Claude Code does not recognise is dropped with no warning. `Grep`, `Glob`
// and `TodoWrite` were all in this list and all silently absent, which is why searching
// goes through Bash here. Check the list against a real dispatch before adding to it.
//
// `Agent` is deliberately absent. A lens that spawns a general-purpose subagent hands it
// the full tool set, `Write` and `Edit` included, and ten lenses share one checkout — so
// the one thing this list exists to prevent would go through the gap. The action closes
// it at the CLI; a session has only this list. Some skills fan out into subagents and
// will do their passes one after another instead.
//
// `WebFetch` and `WebSearch` are absent for the matching reason on the way out. A lens
// reads a diff written by whoever opened the pull request, and `Bash` hands it
// CLAUDE_CODE_OAUTH_TOKEN out of the environment it inherits and the git credential out
// of the checkout. Egress is what turns reading those into losing them. A lens that
// wants a CVE looked up says so in its finding instead.
const TOOLS = "Read, Bash, Skill";

const AGENTS_DIR = "agents";

const check = process.argv.includes("--check");

const manifest = JSON.parse(await Bun.file(".claude-plugin/plugin.json").text()) as { name?: string };
const namespace = manifest.name;

if (!namespace) {
    console.error(".claude-plugin/plugin.json declares no `name`, so no skill can be referenced");
    process.exit(1);
}

const brief = await Bun.file("review/lens-brief.md").text();
const schema = (await Bun.file("review/lens-schema.json").text()).trim();

function render(skillLine: string): string {
    return brief.replace("__SKILL_LINE__", skillLine).replace("__SCHEMA__", schema);
}

function agent(name: string, description: string, body: string): string {
    return `---\nname: ${name}\ndescription: ${description}\ntools: ${TOOLS}\n---\n\n${body}`;
}

const wanted = new Map<string, string>();

for (const entry of readdirSync("lenses/skills", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(`lenses/skills/${entry.name}/SKILL.md`)) continue;

    // The generic agent below takes this name and is written last, so a lens called
    // `lens` would silently get the generic agent instead of its own.
    if (entry.name === "lens") {
        console.error("a lens cannot be named `lens`: the generic dispatch agent has that name");
        process.exit(1);
    }

    wanted.set(
        `${AGENTS_DIR}/${entry.name}.md`,
        agent(
            entry.name,
            `CodeFerret's ${entry.name} lens. Dispatched by /codeferret:review; not for general use.`,
            render(`Load the \`${namespace}:${entry.name}\` skill and have at it.`),
        ),
    );
}

// A lens the plugin does not bundle lives in the reviewed repository's own
// .claude/skills/, so no agent can name its skill ahead of time. This one takes the
// name at dispatch instead.
wanted.set(
    `${AGENTS_DIR}/lens.md`,
    agent(
        "lens",
        "CodeFerret review lens for a skill named at dispatch, for a lens the plugin does not bundle. Dispatched by /codeferret:review; not for general use.",
        render("Load the skill named in the instruction below and have at it."),
    ),
);

let problems = 0;

for (const [path, content] of wanted) {
    if (!check) {
        await Bun.write(path, content);
        continue;
    }

    const current = existsSync(path) ? await Bun.file(path).text() : null;

    if (current === null) {
        console.error(`✘ ${path} is missing`);
        problems += 1;
    } else if (current !== content) {
        console.error(`✘ ${path} does not match review/lens-brief.md`);
        problems += 1;
    }
}

for (const entry of existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR) : []) {
    if (!entry.endsWith(".md")) continue;
    if (wanted.has(`${AGENTS_DIR}/${entry}`)) continue;

    console.error(`✘ ${AGENTS_DIR}/${entry} has no lens behind it — move it to ~/.Trash/`);
    problems += 1;
}

if (problems > 0) {
    console.error(
        check
            ? "\nRun `bun scripts/build-lens-agents.ts` to regenerate."
            : "\nThe agents were written. Deal with the files above by hand.",
    );
    process.exit(1);
}

console.log(`✔ ${AGENTS_DIR} — ${wanted.size} agent(s)${check ? " match review/lens-brief.md" : " written"}`);
