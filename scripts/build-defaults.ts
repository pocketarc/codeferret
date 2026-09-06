#!/usr/bin/env bun
/**
 * Write what a run needs to know about action.yml and the plugin manifest, out of both.
 *
 * A Claude Code session cannot read a YAML default, so `/codeferret:review` cats
 * review/defaults/*.txt to get the same lenses and exclusions the action runs. The upload
 * step's name and retention window are decisions action.yml makes that fetch-previous.ts has
 * to act on, so they leave here as a module it imports. And the plugin namespace comes from
 * the plugin manifest, which build-prompts.sh writes into every dispatch.
 *
 * Generated rather than checked. Both used to be spelled out a second time by hand with a
 * check reconciling the copies, and a check only reports drift after somebody has written
 * the second copy; there is nothing to reconcile when there is one copy. The artifact name
 * never had a check at all, and renaming it in action.yml alone would have left every review
 * repeating every finding, with nothing red anywhere.
 *
 * Usage: bun scripts/build-defaults.ts [--check]
 */

import { join } from "node:path";
import { lines } from "../review/lines.ts";
import { writeOrCheck } from "./generated.ts";

process.chdir(join(import.meta.dir, ".."));

const FILES: Array<[string, string]> = [
    ["lenses", "review/defaults/lenses.txt"],
    ["exclude-paths", "review/defaults/exclude-paths.txt"],
];

const ARTIFACT_MODULE = "review/artifact.ts";

const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
const NAMESPACE_FILE = "review/defaults/namespace.txt";

const check = process.argv.includes("--check");

interface Step {
    uses?: unknown;
    with?: Record<string, unknown>;
}

const action = Bun.YAML.parse(await Bun.file("action.yml").text()) as {
    inputs?: Record<string, { default?: unknown }>;
    runs?: { steps?: Step[] };
};

const wanted = new Map<string, string>();
let problems = 0;

for (const [input, path] of FILES) {
    // Narrowed rather than coerced, for the reason `lines` gives.
    const value = action.inputs?.[input]?.default;
    const entries = typeof value === "string" ? lines(value) : [];

    if (entries.length === 0) {
        console.error(`FAIL action.yml: input '${input}' has no newline-separated default to write to ${path}`);
        problems += 1;
        continue;
    }

    wanted.set(path, `${entries.join("\n")}\n`);
}

// Refused rather than defaulted, like the two below it. A namespace guessed at here is one
// every `<namespace>:<lens>` dispatch would name and no agent would answer to, and the review
// comes back empty for no stated reason.
//
// Held to a single non-empty line, which is what `cat` reads back and nothing more. Which
// characters a namespace may carry stays with `plain_name` in lib.sh.
const plugin = JSON.parse(await Bun.file(PLUGIN_MANIFEST).text()) as { name?: unknown };

if (typeof plugin.name !== "string" || plugin.name.trim() === "" || plugin.name.includes("\n")) {
    console.error(`FAIL ${PLUGIN_MANIFEST}: \`name\` is not a single line of text`);
    problems += 1;
} else {
    wanted.set(NAMESPACE_FILE, `${plugin.name.trim()}\n`);
}

const upload = (action.runs?.steps ?? []).find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact"),
);

const artifactName = upload?.with?.name;
const retention = upload?.with?.["retention-days"];

// Each one is refused rather than defaulted. A name guessed at here would be one the upload
// step does not use, and the only symptom is a review repeating itself; a guessed retention
// window would stop the paging at artifacts that are still downloadable.
if (typeof artifactName !== "string" || !/^[\w.-]+$/.test(artifactName)) {
    console.error(`FAIL action.yml: the upload step's \`name\` is not a plain artifact name`);
    problems += 1;
} else if (typeof retention !== "number" || !Number.isInteger(retention) || retention <= 0) {
    console.error(`FAIL action.yml: the upload step's \`retention-days\` is not a whole number of days`);
    problems += 1;
} else {
    wanted.set(
        ARTIFACT_MODULE,
        `/**
 * What the action's upload step declares, for the run that reads an artifact back.
 *
 * The name is protocol between the step that writes the artifact and the run that opens it,
 * and nothing older than the retention window is still downloadable, so paging past it walks
 * artifacts GitHub has already deleted.
 *
 * Generated from action.yml by scripts/build-defaults.ts. Edit action.yml, not this file.
 */

export const ARTIFACT_NAME = ${JSON.stringify(artifactName)};
export const RETENTION_DAYS = ${retention};
`,
    );
}

problems += (await writeOrCheck(wanted, check, "bun scripts/build-defaults.ts")).problems;

if (problems > 0) process.exit(1);

console.log(`OK generated from the manifests: ${wanted.size} file(s)${check ? " match" : " written"}`);
