#!/usr/bin/env bun
/**
 * Adapt a vendored skill for use as a lens: the frontmatter of its SKILL.md, and the
 * markdown of every file vendored beside it.
 *
 * `name` becomes the local directory name: one plugin means one namespace, and more
 * than one upstream ships a skill called `security-review`.
 *
 * `user-invocable: false` is removed, which keeps `/codeferret:<lens>` available for
 * running one lens by hand. On 2.1.220 the flag hides the slash menu entry and nothing
 * else: the skill still registers, and the model still sees it.
 *
 * `description` is replaced. Upstream wrote it to win the skill an invocation:
 * writing-review asks to be used "proactively whenever writing, reviewing, or
 * rewriting text". That is right for a skill somebody installed on purpose and wrong
 * for a set that arrived together inside a code review tool. Left alone, installing
 * CodeFerret means a lens fires while you are drafting a blog post. A lens agent is
 * told which skill to load by name, so nothing downstream reads this.
 *
 * The body rewrites, in rewrite-markdown.ts, all close the same mismatch: upstream wrote
 * for a person typing a slash command in their own checkout, and a dispatched lens is not
 * that.
 *
 * Two things are deliberately left alone. `allowed-tools` is inert here, because an
 * agent's `tools:` list is a hard boundary a skill cannot widen: sentry-security-review
 * asking for `Bash, Task` gets it nothing. And upstream's prose stays as written, Title
 * Case headings and all, because the commit in PROVENANCE.tsv is only worth pinning while
 * the vendored copy still matches it.
 *
 * Frontmatter is edited a line at a time rather than parsed and re-emitted, unlike
 * validate-manifests.ts, which parses it. A YAML round-trip reformats every key this
 * script does not touch and drops the comments some skills carry.
 *
 * Usage: bun prepare-skill.ts <SKILL.md> <name>
 */

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { rewriteMarkdown } from "./rewrite-markdown.ts";

const [path, name] = process.argv.slice(2);

if (!path || !name) {
    console.error("usage: bun prepare-skill.ts <SKILL.md> <name>");
    process.exit(2);
}

const text = await Bun.file(path).text();
const match = text.match(/^---\n([\s\S]*?)\n---\n/);

if (!match) {
    console.error(`${path}: no YAML frontmatter block`);
    process.exit(1);
}

const frontmatter = match[1];

if (frontmatter === undefined) {
    console.error(`${path}: frontmatter block is empty`);
    process.exit(1);
}

let lines = frontmatter.split("\n");

const nameIndex = lines.findIndex((l) => /^name:/.test(l));
const declaredName = nameIndex === -1 ? undefined : lines[nameIndex];
const previous = declaredName === undefined ? null : declaredName.replace(/^name:\s*/, "").trim();

if (nameIndex === -1) {
    lines.unshift(`name: ${name}`);
} else {
    lines[nameIndex] = `name: ${name}`;
}

function strip(pattern: RegExp): boolean {
    const before = lines.length;
    lines = lines.filter((line) => !pattern.test(line));
    return lines.length < before;
}

const strippedInvocable = strip(/^user-invocable:\s*false\s*$/);

// `disable-model-invocation: true` leaves a skill reachable only by a person typing its
// slash command. A lens agent loads its skill through the Skill tool, which is model
// invocation, so the flag would leave the lens with nothing to load and a review with
// one silent hole in it.
const strippedModelInvocation = strip(/^disable-model-invocation:\s*true\s*$/);

// `argument-hint` is the text Claude Code shows beside the slash command as you type it,
// and upstream wrote it for somebody invoking the skill by hand: accessibility-review's
// hint is a Figma URL. A lens agent loads the skill by name and passes no argument, so
// nothing ever supplies what the hint asks for. The body placeholders that argument
// would have filled are rewritten below.
const strippedHint = strip(/^argument-hint:/);

// Quoted, and free of `: `, because an unquoted colon-space ends the value and leaves
// the rest as a key. Claude Code's parser is lenient enough to hide that; Bun.YAML is
// not, and neither is anything else that reads a skill.
const scoped =
    `description: "CodeFerret review lens ${name}. A CodeFerret lens agent loads this` +
    ` during a multi-lens code review; it is not a general-purpose skill and is no use` +
    ` outside one."`;

const descriptionIndex = lines.findIndex((l) => /^description:/.test(l));

if (descriptionIndex === -1) {
    lines.push(scoped);
} else {
    // A description can be a folded block scalar or a wrapped quoted string, both of
    // which continue over indented lines until the next key at column zero.
    let end = descriptionIndex + 1;
    while (end < lines.length && /^(\s|$)/.test(lines[end] ?? "")) end += 1;

    lines.splice(descriptionIndex, end - descriptionIndex, scoped);
}

const notes: string[] = [];

const skillDirectory = dirname(path);
const skillFile = resolve(path);
let sawSkillFile = false;

// Everything vendored, not only SKILL.md: caveman-review ships a README carrying a link
// to the repository root it came from, and a lens reads what it is handed.
for (const entry of readdirSync(skillDirectory, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".md")) continue;

    const file = join(skillDirectory, entry);
    const isSkill = resolve(file) === skillFile;
    const contents = isSkill ? text : await Bun.file(file).text();
    const prefix = isSkill ? `---\n${lines.join("\n")}\n---\n` : "";
    const body = isSkill ? text.slice(match[0].length) : contents;
    const pass = rewriteMarkdown(entry, body);
    const rewritten = prefix + pass.text;

    notes.push(...pass.notes);
    sawSkillFile ||= isSkill;

    if (rewritten !== contents) await Bun.write(file, rewritten);
}

// The frontmatter is written as part of the walk, so a SKILL.md the walk never reaches
// loses every rewrite above without a word.
if (!sawSkillFile) {
    console.error(`${path}: is not a markdown file inside ${skillDirectory}`);
    process.exit(1);
}

if (previous === null) {
    console.log(`  added missing skill name '${name}'`);
} else if (previous !== name) {
    console.log(`  renamed skill '${previous}' -> '${name}'`);
}

if (strippedInvocable) {
    console.log(`  removed 'user-invocable: false' so '/codeferret:${name}' stays in the slash menu`);
}

if (strippedModelInvocation) {
    console.log("  removed 'disable-model-invocation: true' so a lens agent can load it");
}

if (strippedHint) {
    console.log("  removed 'argument-hint', which a dispatched lens has no argument for");
}

for (const note of notes) console.log(note);

console.log(`  scoped the description to '${name}' as a CodeFerret lens`);
