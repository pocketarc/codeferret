#!/usr/bin/env bun
/**
 * Adapt a vendored skill's frontmatter for use as a lens.
 *
 * `name` becomes the local directory name: one plugin means one namespace, and more
 * than one upstream ships a skill called `security-review`.
 *
 * `user-invocable: false` is removed. A skill carrying it never registers as a skill,
 * and a lens subagent loads its skill by name.
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

await Bun.write(path, `---\n${lines.join("\n")}\n---\n${body}`);

if (previous === null) {
    console.log(`  added missing skill name '${name}'`);
} else if (previous !== name) {
    console.log(`  renamed skill '${previous}' -> '${name}'`);
}

if (strippedInvocable) {
    console.log("  removed 'user-invocable: false' so the skill registers by name");
}
