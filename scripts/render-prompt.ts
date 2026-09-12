#!/usr/bin/env bun
/**
 * Fill a prompt template's placeholders and write the result.
 *
 * Substitution here rather than in sed, because sed needs a delimiter and every value then
 * has to be escaped against it. A path or a ref carrying `|`, `&` or `\` is ordinary, and
 * one that got past the escaper would end the sed command early or be read as a
 * back-reference.
 *
 * The other thing sed cannot do is complain. A placeholder nothing fills travels into the
 * orchestrator's prompt as `__BASE__`, and the only symptom is a model reading a literal.
 * Anything left over fails here instead.
 *
 * Usage: bun scripts/render-prompt.ts <template> <out> [--indent <n>] <NAME>=<value>...
 *                                                                    <NAME>@<file>...
 *
 * `=` substitutes the value wherever the name appears. `@` replaces the whole line the name
 * sits on with the contents of the file, which is how a rendered block is spliced in.
 * `--indent` prefixes every non-empty line of the result, so a block sits inside another
 * prompt without the blank lines picking up trailing whitespace.
 *
 * Both kinds are applied in one pass over the template's own lines, so no value is ever
 * scanned for a later name. A name is required to look like `__NAME__` for that reason.
 */

const [template, out, ...rest] = process.argv.slice(2);

if (!template || !out) {
    console.error("usage: bun scripts/render-prompt.ts <template> <out> [--indent <n>] <NAME>=<value>...");
    process.exit(2);
}

const args: string[] = [];
let indent = 0;

for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";

    if (arg === "--indent") {
        const width = Number(rest[i + 1]);

        if (!Number.isInteger(width) || width < 0) {
            console.error(`--indent takes a whole number of spaces, not '${rest[i + 1]}'`);
            process.exit(2);
        }

        indent = width;
        i += 1;
        continue;
    }

    args.push(arg);
}

const PLACEHOLDER = /__[A-Z_]+__/g;

const values = new Map<string, string>();
const splices: Array<[string, string]> = [];

for (const arg of args) {
    const equals = arg.indexOf("=");
    const at = arg.indexOf("@");
    const first = equals === -1 ? at : at === -1 ? equals : Math.min(equals, at);

    if (first < 1) {
        console.error(`'${arg}' is neither <NAME>=<value> nor <NAME>@<file>`);
        process.exit(2);
    }

    const name = arg.slice(0, first);
    const value = arg.slice(first + 1);

    // The name has to be the shape the leftover check at the end looks for, because the
    // single pass below finds names with that pattern rather than searching for each one.
    // A name of any other shape would be silently substituted nowhere.
    if (!new RegExp(`^${PLACEHOLDER.source}$`).test(name)) {
        console.error(`'${name}' is not a placeholder name of the form __NAME__`);
        process.exit(2);
    }

    if (arg[first] === "@") {
        splices.push([name, value]);
        continue;
    }

    values.set(name, value);
}

const blocks = new Map<string, string>();

for (const [name, file] of splices) {
    blocks.set(name, (await Bun.file(file).text()).replace(/\n$/, ""));
}

// One pass over the template's own lines, never over what a substitution produced. Run as
// two passes it was not: `__BASE__` is filled first and `plain_ref` allows every character
// in `__DISPATCH__`, so a pull request opened against a base branch named for another
// placeholder had that name substituted in, and the splice pass then replaced the line
// naming the base ref with the whole dispatch block. Nothing was left over, so the check at
// the end saw a finished prompt that was simply wrong about what to diff.
// Recorded as the pass runs rather than found by re-reading the result, because a value
// may legally be a placeholder name: a base branch called `__DISPATCH__` is substituted in
// as itself, and a check that re-scanned the output would call the finished prompt unfilled.
const unfilled = new Set<string>();

let text = (await Bun.file(template).text())
    .split("\n")
    .map((line) => {
        // A splice replaces the whole line it sits on, and the block goes in verbatim: it
        // arrives exactly as its own run of this script rendered it, placeholders filled.
        for (const [name, block] of blocks) {
            if (line.includes(name)) {
                return block;
            }
        }

        // A replacer function, because `replace` reads `$&`, `` $` `` and `$1` in a
        // replacement string as substitutions of its own, and a path or a diff range can
        // hold any of them.
        return line.replace(PLACEHOLDER, (name) => {
            const value = values.get(name);

            if (value === undefined) {
                unfilled.add(name);

                return name;
            }

            return value;
        });
    })
    .join("\n");

if (indent > 0) {
    const pad = " ".repeat(indent);
    text = text
        .split("\n")
        .map((line) => (line === "" ? line : `${pad}${line}`))
        .join("\n");
}

if (unfilled.size > 0) {
    console.error(`${template}: nothing filled ${[...unfilled].join(", ")}`);
    process.exit(1);
}

await Bun.write(out, text);

export {};
