#!/usr/bin/env bun
/**
 * Adapt a vendored skill's frontmatter for use as a lens.
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
 * for twelve that arrived together inside a code review tool. Left alone, installing
 * CodeFerret means a lens fires while you are drafting a blog post. A lens agent is
 * told which skill to load by name, so nothing downstream reads this.
 *
 * Usage: bun prepare-skill.ts <SKILL.md> <name>
 */

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

const body = text.slice(match[0].length);
let lines = match[1].split("\n");

const nameIndex = lines.findIndex((l) => /^name:/.test(l));
const previous = nameIndex === -1 ? null : lines[nameIndex].replace(/^name:\s*/, "").trim();

if (nameIndex === -1) {
    lines.unshift(`name: ${name}`);
} else {
    lines[nameIndex] = `name: ${name}`;
}

const beforeCount = lines.length;
lines = lines.filter((l) => !/^user-invocable:\s*false\s*$/.test(l));
const strippedInvocable = lines.length < beforeCount;

// `disable-model-invocation: true` leaves a skill reachable only by a person typing its
// slash command. A lens agent loads its skill through the Skill tool, which is model
// invocation, so the flag would leave the lens with nothing to load and a review with
// one silent hole in it.
const beforeModel = lines.length;
lines = lines.filter((l) => !/^disable-model-invocation:\s*true\s*$/.test(l));
const strippedModelInvocation = lines.length < beforeModel;

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
    while (end < lines.length && /^(\s|$)/.test(lines[end])) end += 1;

    lines.splice(descriptionIndex, end - descriptionIndex, scoped);
}

await Bun.write(path, `---\n${lines.join("\n")}\n---\n${body}`);

if (previous === null) {
    console.log(`  added missing skill name '${name}'`);
} else if (previous !== name) {
    console.log(`  renamed skill '${previous}' -> '${name}'`);
}

if (strippedInvocable) {
    console.log("  removed 'user-invocable: false' so the skill registers by name");
}

if (strippedModelInvocation) {
    console.log("  removed 'disable-model-invocation: true' so a lens agent can load it");
}

console.log(`  scoped the description to '${name}' as a CodeFerret lens`);
