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

let text = await Bun.file(template).text();

// Substitutions run before splices, so a spliced-in block arrives exactly as its own run
// of this script rendered it, with its own placeholders already filled.
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

    if (arg[first] === "@") {
        splices.push([name, value]);
        continue;
    }

    // A replacer function, because `replace` reads `$&`, `` $` `` and `$1` in a replacement
    // string as substitutions of its own, and a path or a diff range can hold any of them.
    text = text.replaceAll(name, () => value);
}

for (const [name, file] of splices) {
    const block = (await Bun.file(file).text()).replace(/\n$/, "");
    const lines = text.split("\n").map((line) => (line.includes(name) ? block : line));

    text = lines.join("\n");
}

if (indent > 0) {
    const pad = " ".repeat(indent);
    text = text
        .split("\n")
        .map((line) => (line === "" ? line : `${pad}${line}`))
        .join("\n");
}

const left = text.match(/__[A-Z_]+__/g);

if (left) {
    console.error(`${template}: nothing filled ${[...new Set(left)].join(", ")}`);
    process.exit(1);
}

await Bun.write(out, text);

export {};
