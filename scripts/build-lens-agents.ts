#!/usr/bin/env bun
/**
 * Render the lens agent definitions the plugin ships.
 *
 * A plugin's agents load when the session starts, so an agent cannot contain anything
 * that varies per run. The base ref and the pathspec both do, so both go in the dispatch
 * prompt (review/lens-dispatch.md) instead. That leaves the skill name and the output
 * schema, which are fixed per lens.
 *
 * Everything in agents/ is generated from review/lens-brief.md by this script. Run it
 * after editing that file; validate-manifests.ts re-runs it with --check and fails when
 * the checked-in agents have drifted.
 *
 * Usage: bun scripts/build-lens-agents.ts [--check]
 *        bun scripts/build-lens-agents.ts --one <lens-name> <out-path>
 *
 * `--one` renders a single agent for a lens the plugin does not bundle, which lives in
 * the reviewed repository's own .claude/skills/ and so cannot have an agent checked in.
 * build-prompts.sh calls it while assembling the run's plugin.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeOrCheck } from "./generated.ts";

// Every path below is repository-relative, and whoever has just edited this script is
// standing in scripts/. Without this the run dies on a raw ENOENT or writes an agents/
// tree wherever the caller happened to be.
process.chdir(join(import.meta.dir, ".."));

// No Write, Edit or NotebookEdit, matching what the action denies at the CLI. Naming the
// set rather than subtracting from it also leaves out every MCP tool, which a diff
// review has no use for and which the action drops with --strict-mcp-config.
//
// On 2.1.220, naming `Bash` in this list means no `Grep` and no `Glob`: call either and
// the reply is "Grep is not available in this session — search file contents with grep
// via the Bash tool instead". A lens has to run `git diff`, so it gets `Bash` in any
// case, and searching goes through Bash as well. Claude Code drops a name it does not
// recognise at dispatch without a word, which is what becomes of `Task`, the subagent
// tool's old name. Check the list against a real dispatch before adding to it.
//
// `Agent` is deliberately absent. A lens that spawns a general-purpose subagent hands it
// the full tool set, `Write` and `Edit` included, and every lens shares one checkout, so
// the one thing this list exists to prevent would go through the gap. The action closes
// it at the CLI; a session has only this list. Some skills fan out into subagents and
// will do their passes one after another instead.
//
// `WebFetch` and `WebSearch` are absent for the matching reason on the way out. A lens
// reads a diff written by whoever opened the pull request, and a lens with `Bash` can read
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

// Text meant for one lens and no other belongs in that lens's own system prompt. Routed
// through the orchestrator instead (as the `REVIEW.md` instruction was), it becomes a
// line the orchestrator has to hand to the right lens and no one else, every run, and
// nothing downstream can tell when it gets that wrong.
async function extrasFor(lens: string): Promise<string> {
    const path = `review/lens-extras/${lens}.md`;
    return existsSync(path) ? `\n${(await Bun.file(path).text()).trim()}\n` : "";
}

/**
 * The extras go where lens-brief.md puts `__EXTRAS__`, above the closing instruction to
 * return the schema. Below it, a reader takes a standing instruction for part of the
 * output format, which is what everything else the lens must remember sits above.
 */
function render(skillLine: string, extras: string): string {
    // Replacer functions, because `replace` reads `$&`, `` $` `` and `$1` in a
    // replacement *string* as substitutions, and JSON Schema's whole vocabulary is
    // `$schema`, `$ref`, `$defs`.
    return brief
        .replace("__SKILL_LINE__", () => skillLine)
        .replace("__EXTRAS__", () => extras)
        .replace("__SCHEMA__", () => schema);
}

function agent(name: string, description: string, body: string): string {
    return `---\nname: ${name}\ndescription: ${description}\ntools: ${TOOLS}\n---\n\n${body}`;
}

const one = process.argv.indexOf("--one");

if (one !== -1) {
    const [lens, outPath] = process.argv.slice(one + 1);

    if (!lens || !outPath) {
        console.error("usage: bun scripts/build-lens-agents.ts --one <lens-name> <out-path>");
        process.exit(2);
    }

    // Namespaced like a bundled lens, because build-prompts.sh copies the workspace skill
    // into the run's plugin beside this agent. It cannot be loaded where it lives: run.sh
    // passes `--setting-sources user`, which on 2.1.220 puts a project's own
    // .claude/skills/ out of the session's reach along with everything else the reviewed
    // tree declares.
    await Bun.write(
        outPath,
        agent(
            lens,
            `CodeFerret's ${lens} lens, from this repository's own .claude/skills/. Dispatched by /codeferret:review; not for general use.`,
            render(`Load the \`${namespace}:${lens}\` skill and review the diff under it.`, await extrasFor(lens)),
        ),
    );

    console.log(`OK ${outPath}: agent for the unbundled lens '${lens}'`);
    process.exit(0);
}

const wanted = new Map<string, string>();

for (const entry of readdirSync("lenses/skills", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(`lenses/skills/${entry.name}/SKILL.md`)) continue;

    wanted.set(
        `${AGENTS_DIR}/${entry.name}.md`,
        agent(
            entry.name,
            `CodeFerret's ${entry.name} lens. Dispatched by /codeferret:review; not for general use.`,
            render(
                `Load the \`${namespace}:${entry.name}\` skill and review the diff under it.`,
                await extrasFor(entry.name),
            ),
        ),
    );
}

let problems = (await writeOrCheck(wanted, check, "bun scripts/build-lens-agents.ts")).problems;

// An agent left behind by a lens that has gone. Nothing regenerates it away, so it is
// reported separately from the files this script owns.
for (const entry of existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR) : []) {
    if (!entry.endsWith(".md")) continue;
    if (wanted.has(`${AGENTS_DIR}/${entry}`)) continue;

    const lens = entry.replace(/\.md$/, "");
    console.error(
        `FAIL ${AGENTS_DIR}/${entry} has no lens behind it. Delete it, or add lenses/skills/${lens}/SKILL.md.`,
    );
    problems += 1;
}

if (problems > 0) process.exit(1);

console.log(`OK ${AGENTS_DIR}: ${wanted.size} agent(s)${check ? " match review/lens-brief.md" : " written"}`);
