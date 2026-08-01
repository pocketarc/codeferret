#!/usr/bin/env bun
/**
 * Write review/defaults/*.txt from the input defaults in action.yml.
 *
 * A Claude Code session cannot read a YAML default, so `/codeferret:review` cats these
 * files to get the same lenses, tools and exclusions the action runs. Generating them
 * keeps action.yml the one place a default is written; hand-keeping a second copy and
 * diffing it only reports the drift after somebody has shipped it.
 *
 * Usage: bun scripts/build-defaults.ts [--check]
 */

import { join } from "node:path";

// Every path below is repository-relative, and whoever has just edited this script is
// standing in scripts/.
process.chdir(join(import.meta.dir, ".."));

const FILES: Array<[string, string]> = [
    ["lenses", "review/defaults/lenses.txt"],
    ["exclude-paths", "review/defaults/exclude-paths.txt"],
    ["tools", "review/defaults/tools.txt"],
];

const check = process.argv.includes("--check");

const action = Bun.YAML.parse(await Bun.file("action.yml").text()) as {
    inputs?: Record<string, { default?: unknown }>;
};

let problems = 0;

for (const [input, path] of FILES) {
    const entries = String(action.inputs?.[input]?.default ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    if (entries.length === 0) {
        console.error(`FAIL action.yml: input '${input}' has no default to write to ${path}`);
        problems += 1;
        continue;
    }

    const wanted = `${entries.join("\n")}\n`;

    if (!check) {
        await Bun.write(path, wanted);
        continue;
    }

    const current = await Bun.file(path)
        .text()
        .catch(() => null);

    if (current !== wanted) {
        console.error(`FAIL ${path} does not match the \`${input}\` default in action.yml`);
        problems += 1;
    }
}

if (problems > 0) {
    if (check) console.error("\nRun `bun scripts/build-defaults.ts` to regenerate.");
    process.exit(1);
}

console.log(`OK review/defaults: ${FILES.length} file(s)${check ? " match action.yml" : " written"}`);
