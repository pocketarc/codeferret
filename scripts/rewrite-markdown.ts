/**
 * The body rewrites a vendored skill needs, as three passes over its lines.
 *
 * One of these deletes whole lines on a heuristic, which is why they sit apart from
 * prepare-skill.ts: otherwise the only way to check one is to vendor a skill and read the
 * diff.
 *
 * Every pass leaves what is inside a fenced block alone. A placeholder in a fence is being
 * shown rather than obeyed: upstream's Usage block documents
 * `/accessibility-review $ARGUMENTS`, and one reference file passes `$1` to a
 * parameterised SQL query.
 */

import { fenceMap } from "../review/markdown.ts";

/** Lines to write, and a line of explanation for each change, printed at vendor time. */
export interface Pass {
    lines: string[];
    notes: string[];
}

const HEADING = /^(#{1,6})\s/;

/**
 * A link out of the skill's own directory. Only that directory is vendored, so
 * `../../CONNECTORS.md` resolves to nothing once the skill is here.
 *
 * The leading `!` is part of the match so that an image goes whole, sigil and all, rather
 * than leaving one in front of the alt text.
 */
const ABOVE_SKILL_LINK = /!?\[([^\]]*)\]\((?:\.\.\/)+[^)]*\)/g;

const LIST_ITEM = /^\s*(?:>\s*)?[-*+]\s/;

/** The whole of what may come before the link text in a line that is only a pointer. */
const ONLY_A_DIRECTIVE = /^(?:also\s+)?(?:please\s+)?(?:see|read|check|consult|refer to)\b[\s,:—-]*$/i;

/** The whole of what may come after it: punctuation, and the filler a pointer trails off in. */
const ONLY_FILLER =
    /^(?:[\s.,;:!?)]|\b(?:for|more|the|rest|details|information|guidance|context|below|and)\b)*$/i;

/**
 * Anthropic's knowledge-work plugins end a skill with a section conditioned on the user's
 * MCP connectors: inspect the colours in Figma, file a ticket per finding. A review
 * session runs with `--strict-mcp-config` and no connectors at all, so this is a page of
 * instructions for a capability the lens does not have. It also holds the `~~design tool`
 * placeholders that the CONNECTORS.md link explained.
 */
const CONNECTORS_HEADING = /^#{1,6}\s+If Connectors Available\s*$/i;

/**
 * What a slash command would have substituted, in a run where nothing does. Left in,
 * `Audit for accessibility: @$1` reaches the model as `Audit for accessibility: @`, an
 * instruction naming nothing. The dispatch names the diff, so the replacement does too.
 *
 * `${selection}` and its siblings are the same thing from GitHub Copilot's prompt files,
 * which two vendored skills came from. Left in, they are the first instruction a lens
 * follows after loading its skill.
 *
 * `@` is required in front of a digit. The bare `$1` through `$9` are PostgreSQL and
 * node-postgres bind placeholders, and they turn up in exactly the prose a SQL or a
 * security skill is vendored for: "WHERE id = $1" would become "WHERE id = the diff under
 * review", which is a broken illustration of the one defence against SQL injection.
 */
const ARGUMENT_PLACEHOLDER =
    /(?:@\$(?:ARGUMENTS|[1-9])|\$ARGUMENTS)\b|\$\{(?:selection|file|fileBasename|fileDirname|workspaceFolder)\}/g;

const TARGET = "the diff under review";

/**
 * The fallback clause a placeholder carried for the run where nothing filled it.
 *
 * The SQL skill opens "review of ${selection} (or entire project if no selection)". Once
 * the placeholder is substituted, what is left of the clause offers a whole-schema scan,
 * which spends the run's budget on code the change did not touch.
 *
 * Stripped whether or not the placeholder is still on the line, so re-running this over a
 * skill vendored before the pass existed repairs that copy too. A lens always has a
 * selection, so the condition can never hold, whatever else the sentence is about.
 */
const NO_SELECTION_FALLBACK = /\s*\(\s*or\s+[^)]*\bif\s+no\s+selection\s*\)/gi;

/**
 * Whether a line, once its dead link has become plain text, is nothing but a pointer at a
 * file that is not here.
 *
 * Keeping the text of every stripped link leaves instructions to read files that were
 * never vendored, and a lens follows them: hunting for a file that is not there, and
 * reporting the hunt as a finding.
 *
 * The directive has to be the whole of the line around the pointer, so that a line whose
 * pointer is incidental to it survives.
 */
export function isPointerOnly(line: string, linkTexts: string[]): boolean {
    const bare = line.replace(/^\s*(?:>\s*)?(?:[-*+]\s+)?/, "").trim();

    // A link with no text at all names nothing, and every string starts with the empty one,
    // so leaving it in would make the `startsWith` below true for every line.
    const named = linkTexts.filter((text) => text !== "");

    if (named.some((text) => bare === text || bare === `${text}.`)) return true;

    // A bullet whose whole content is the pointer. The tail still has to be filler, for the
    // reason the branch below applies the same test: `- [the shared palette](…) is the
    // source of truth; body text is 4.5:1` starts with the link text and carries the
    // threshold after it, and dropping the line drops the threshold.
    if (
        LIST_ITEM.test(line) &&
        named.some((text) => bare.startsWith(text) && ONLY_FILLER.test(bare.slice(text.length)))
    ) {
        return true;
    }

    return named.some((text) => {
        const at = bare.lastIndexOf(text);

        if (at === -1) return false;

        return ONLY_A_DIRECTIVE.test(bare.slice(0, at)) && ONLY_FILLER.test(bare.slice(at + text.length));
    });
}

/**
 * The lines with the dropped ones gone, closing the blank-line pair each one leaves.
 *
 * A maintainer diffs a vendored skill against the commit PROVENANCE.tsv pins, so a rewrite
 * that turns one blank line into two is noise in that diff for as long as the pin stands.
 */
function without(lines: string[], dropped: Set<number>): string[] {
    const out: string[] = [];
    let closeTheGap = false;

    for (const [i, line] of lines.entries()) {
        if (dropped.has(i)) {
            closeTheGap = out[out.length - 1] === "";
            continue;
        }

        if (closeTheGap) {
            closeTheGap = false;
            if (line.trim() === "") continue;
        }

        out.push(line);
    }

    return out;
}

/** Drop the "If Connectors Available" section: its heading and everything under it. */
export function dropConnectorsSection(label: string, lines: string[]): Pass {
    const notes: string[] = [];
    const fenced = fenceMap(lines);
    const dropped = new Set<number>();
    let depth = 0;

    lines.forEach((line, i) => {
        const heading = fenced[i] ? null : line.match(HEADING);
        const hashes = heading?.[1] ?? "";

        if (depth > 0) {
            if (!heading || hashes.length > depth) {
                dropped.add(i);
                return;
            }

            depth = 0;
        }

        if (heading && CONNECTORS_HEADING.test(line)) {
            depth = hashes.length;
            dropped.add(i);
            notes.push(`  ${label}: dropped the 'If Connectors Available' section; a lens session has none`);
        }
    });

    return { lines: without(lines, dropped), notes };
}

/**
 * Strip links reaching above the skill directory, keeping their text.
 *
 * The text stays because the sentence around it is usually the part worth reading: drop
 * the line and "check contrast against [the shared palette](../shared/palette.md), 4.5:1
 * for body text" takes the threshold with it. A line that was only the pointer goes.
 */
export function stripDeadLinks(label: string, lines: string[]): Pass {
    const notes: string[] = [];
    const fenced = fenceMap(lines);
    const dropped = new Set<number>();

    const stripped = lines.map((line, i) => {
        if (fenced[i]) return line;

        const texts: string[] = [];
        const out = line.replace(ABOVE_SKILL_LINK, (_, text: string) => {
            texts.push(text);
            return text;
        });

        if (texts.length === 0) return line;

        if (out.trim() === "") {
            dropped.add(i);
            notes.push(`  ${label}: dropped a line that was only a link reaching above the skill directory`);
            return out;
        }

        if (isPointerOnly(out, texts)) {
            dropped.add(i);
            notes.push(`  ${label}: dropped a line pointing at a file that was not vendored: ${line.trim()}`);
            return out;
        }

        // The original as well, so that a rewrite can be checked at vendor time rather
        // than found in a lens's review months later.
        notes.push(`  ${label}: rewrote ${line.trim()}`);
        notes.push(`  ${label}:      to ${out.trim()}`);

        return out;
    });

    return { lines: without(stripped, dropped), notes };
}

/** Substitute the slash-command placeholders a dispatched lens has no argument for. */
export function substitutePlaceholders(label: string, lines: string[]): Pass {
    const notes: string[] = [];
    const fenced = fenceMap(lines);

    const out = lines.map((line, i) => {
        if (fenced[i]) return line;

        const rewritten = line.replace(ARGUMENT_PLACEHOLDER, TARGET).replace(NO_SELECTION_FALLBACK, "");

        if (rewritten !== line) {
            notes.push(`  ${label}: rewrote ${line.trim()}`);
            notes.push(`  ${label}:      to ${rewritten.trim()}`);
        }

        return rewritten;
    });

    return { lines: out, notes };
}

/** The three passes in order, and everything they changed. */
export function rewriteMarkdown(label: string, markdown: string): { text: string; notes: string[] } {
    const notes: string[] = [];
    let lines = markdown.split("\n");

    for (const pass of [dropConnectorsSection, stripDeadLinks, substitutePlaceholders]) {
        const result = pass(label, lines);
        lines = result.lines;
        notes.push(...result.notes);
    }

    return { text: lines.join("\n"), notes };
}
