#!/usr/bin/env bun
/**
 * Parse action.yml and every workflow, and check the action's shape.
 *
 * GitHub validates workflow syntax when you push, but it does not validate an action
 * manifest until a run tries to load it. A composite action with a YAML error
 * therefore looks fine until it fails at the first step of a real run — which is how
 * an unquoted `pull-requests: write` inside a description shipped once already.
 *
 * Usage: bun scripts/validate-manifests.ts
 */

import { readdirSync } from "node:fs";

let failures = 0;

function fail(file: string, message: string): void {
    console.error(`✘ ${file}: ${message}`);
    failures += 1;
}

async function parse(file: string): Promise<unknown | null> {
    try {
        return Bun.YAML.parse(await Bun.file(file).text());
    } catch (error) {
        fail(file, error instanceof Error ? error.message : String(error));
        return null;
    }
}

const action = (await parse("action.yml")) as {
    name?: string;
    description?: string;
    inputs?: Record<string, { description?: string; required?: boolean; default?: unknown }>;
    runs?: { using?: string; steps?: Array<{ name?: string; shell?: string; uses?: string }> };
} | null;

if (action) {
    if (!action.name) fail("action.yml", "missing `name`");
    if (!action.description) fail("action.yml", "missing `description`");
    if (action.runs?.using !== "composite") {
        fail("action.yml", `runs.using is '${action.runs?.using}', expected 'composite'`);
    }

    const steps = action.runs?.steps ?? [];
    if (steps.length === 0) fail("action.yml", "runs.steps is empty");

    for (const [i, step] of steps.entries()) {
        // A composite `run` step without `shell` is accepted by the YAML parser and
        // rejected by the runner, so it is worth catching here.
        if (!step.uses && !step.shell) {
            fail("action.yml", `step ${i + 1} (${step.name ?? "unnamed"}) has no \`shell\``);
        }
    }

    for (const [name, input] of Object.entries(action.inputs ?? {})) {
        if (!input.description) fail("action.yml", `input '${name}' has no description`);
        if (input.required === true && input.default !== undefined) {
            fail("action.yml", `input '${name}' is required but also has a default`);
        }
    }

    console.log(
        `✔ action.yml — ${Object.keys(action.inputs ?? {}).length} inputs, ${steps.length} steps`,
    );
}

const workflowDir = ".github/workflows";
for (const entry of readdirSync(workflowDir)) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;

    const file = `${workflowDir}/${entry}`;
    const workflow = (await parse(file)) as { jobs?: Record<string, unknown> } | null;
    if (!workflow) continue;

    const jobs = Object.keys(workflow.jobs ?? {});
    if (jobs.length === 0) fail(file, "no jobs");
    else console.log(`✔ ${file} — jobs: ${jobs.join(", ")}`);
}

if (failures > 0) {
    console.error(`\n${failures} problem(s) found.`);
    process.exit(1);
}

console.log("\nall manifests valid");
