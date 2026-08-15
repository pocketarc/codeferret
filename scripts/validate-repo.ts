#!/usr/bin/env bun
/**
 * Every check on this repository that needs no findings file to run.
 *
 * Each manifest the action and the plugin depend on is parsed and its shape checked, along
 * with the values two files have to agree on: the plugin namespace, the shipped version, the
 * defaults, the standing caveats, and everything generated. Both generators are re-run with
 * `--check`, and action.yml's `run:` blocks go through shellcheck, being the only shell in
 * the repository that lives as a string inside YAML.
 *
 * A value with one authority belongs in a generator instead, and two of these checks were
 * deleted by moving one value there. What is left is the pairs where neither side can be
 * derived from the other: a literal in shell against a literal in JSON, a version in prose
 * against the manifest.
 *
 * Nothing upstream catches any of this before somebody feels it. "Before you push" in
 * CLAUDE.md has what a broken manifest costs and what to do about it.
 *
 * This file is the command around them: argv, the run, and the exit code. Each check is a
 * module under `scripts/checks/`, listed once in `scripts/checks/index.ts`, and the shape
 * they share is in `scripts/checks/support.ts`. It was one file of every check at once, and
 * a reader looking for the rule behind a failure had to find it among all the others.
 *
 * Usage: bun scripts/validate-repo.ts [<check-name>...]
 */

import { join } from "node:path";
import type { Failures } from "./checks/support.ts";

// Before the checks are loaded, and they are loaded dynamically so that it is. Every check
// reads paths relative to the repository root; a static import would have its module body run
// before this line, which is why the `chdir` used to sit in `support.ts`, where importing a
// helper relocated the process.
process.chdir(join(import.meta.dir, ".."));

const { CHECKS } = await import("./checks/index.ts");

const named = process.argv.slice(2);
const unknown = named.filter((name) => !CHECKS.some(([check]) => check === name));

if (unknown.length > 0) {
    console.error(`no such check: ${unknown.join(", ")}`);
    console.error(`checks: ${CHECKS.map(([name]) => name).join(", ")}`);
    process.exit(2);
}

const failures: Failures = [];

for (const [name, check] of CHECKS) {
    if (named.length > 0 && !named.includes(name)) continue;
    failures.push(...(await check()));
}

if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`\n${failures.length} problem(s) found.`);
    process.exit(1);
}

console.log("\nevery check passes");
