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
 * for twelve that arrived together inside a code review tool. Left alone, installing
 * CodeFerret means a lens fires while you are drafting a blog post. A lens agent is
 * told which skill to load by name, so nothing downstream reads this.
 *
 * The body rewrites below all close the same mismatch: upstream wrote for a person
 * typing a slash command in their own checkout, and a dispatched lens is not that.
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

// A skill's body can point at a sibling file that was never vendored with it: only the
// skill's own directory is copied, so `../../CONNECTORS.md` resolves to nothing here.
// The link goes and its text stays, because the sentence around it is usually the part
// worth reading: drop the line and "check contrast against [the shared
// palette](../shared/palette.md), 4.5:1 for body text" takes the threshold with it.
const ABOVE_SKILL_LINK = /\[([^\]]*)\]\((?:\.\.\/)+[^)]*\)/g;

const DIRECTIVE = /\b(?:see|read|check|consult|refer to)\b/i;
const LIST_ITEM = /^\s*(?:>\s*)?[-*+]\s/;

/**
 * Whether a line, once its dead link has become plain text, is nothing but a pointer at a
 * file that is not here.
 *
 * Keeping the text of every stripped link leaves instructions to read files that were
 * never vendored. Two lenses opened their review by hunting for CONNECTORS.md, and one
 * reported the hunt as the first finding of the review it was dispatched for.
 */
function isPointerOnly(line: string, linkTexts: string[]): boolean {
    const bare = line.replace(/^\s*(?:>\s*)?(?:[-*+]\s+)?/, "").trim();

    if (linkTexts.some((text) => bare === text || bare === `${text}.`)) return true;
    if (LIST_ITEM.test(line) && linkTexts.some((text) => bare.startsWith(text))) return true;

    return DIRECTIVE.test(bare) && linkTexts.some((text) => bare.includes(text));
}

// What a slash command would have substituted, in a run where nothing does. Left in,
// `Audit for accessibility: @$1` reaches the model as `Audit for accessibility: @`, an
// instruction naming nothing. The dispatch names the diff, so the replacement does too.
//
// `@` is required. The bare `$1` through `$9` are PostgreSQL and node-postgres bind
// placeholders, and they turn up in exactly the prose a SQL or a security skill is
// vendored for: "WHERE id = $1" would become "WHERE id = the diff under review", which is
// a broken illustration of the one defence against SQL injection.
const ARGUMENT_PLACEHOLDER = /(?:@\$(?:ARGUMENTS|[1-9])|\$ARGUMENTS)\b/g;
const TARGET = "the diff under review";

// Anthropic's knowledge-work plugins end a skill with a section conditioned on the
// user's MCP connectors: inspect the colours in Figma, file a ticket per finding. A
// review session runs with `--strict-mcp-config` and no connectors at all, so this is a
// page of instructions for a capability the lens does not have. It also holds the
// `~~design tool` placeholders that the CONNECTORS.md link above explained.
const CONNECTORS_HEADING = /^#{1,6}\s+If Connectors Available\s*$/i;

const HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(?:```|~~~)/;

const notes: string[] = [];

// Inside a fence a placeholder is being shown, not obeyed: upstream's Usage block
// documents `/accessibility-review $ARGUMENTS`, and one reference file passes `$1` to
// a parameterised SQL query. Only prose is rewritten.
function rewriteMarkdown(label: string, markdown: string): string {
    const out: string[] = [];
    let fenced = false;
    let dropping = 0;

    for (const line of markdown.split("\n")) {
        if (FENCE.test(line)) fenced = !fenced;

        const heading = fenced ? null : line.match(HEADING);

        const hashes = heading?.[1] ?? "";

        if (dropping > 0) {
            if (!heading || hashes.length > dropping) continue;
            dropping = 0;
        }

        if (heading && CONNECTORS_HEADING.test(line)) {
            dropping = hashes.length;
            notes.push(`  ${label}: dropped the 'If Connectors Available' section; a lens session has none`);
            continue;
        }

        const deadLinkTexts: string[] = [];

        const rewritten = fenced
            ? line
            : line
                  .replace(ABOVE_SKILL_LINK, (_, linkText: string) => {
                      deadLinkTexts.push(linkText);
                      return linkText;
                  })
                  .replace(ARGUMENT_PLACEHOLDER, TARGET);

        if (rewritten !== line) {
            if (rewritten.trim() === "") {
                notes.push(`  ${label}: dropped a line that was only a link reaching above the skill directory`);
                continue;
            }

            if (deadLinkTexts.length > 0 && isPointerOnly(rewritten, deadLinkTexts)) {
                notes.push(`  ${label}: dropped a line pointing at a file that was not vendored: ${line.trim()}`);
                continue;
            }

            // The original as well, so that a rewrite can be checked at vendor time
            // rather than found in a lens's review months later.
            notes.push(`  ${label}: rewrote ${line.trim()}`);
            notes.push(`  ${label}:      to ${rewritten.trim()}`);
        }

        out.push(rewritten);
    }

    return out.join("\n");
}

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
    const rewritten = prefix + rewriteMarkdown(entry, body);

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
