#!/usr/bin/env bun
/**
 * The report a tool that died before reaching its own reporter never wrote.
 *
 * The `static-analysis` lens accounts for what it was handed, so a tool that left no file
 * leaves no trace in the review at all. This gives the lens something to read, and it
 * writes it through `reporter()` for the reason that module exists: the contract had been
 * held by hand at each end, and a misspelled key once produced a report the lens read as a
 * clean result.
 *
 * Not under `review/tools/`, because run.sh will run anything named there as a tool.
 *
 * Usage: bun tool-stub.ts <tool> <build-dir> <exit-code>
 */

import { join } from "node:path";
import { reporter } from "./tools/report.ts";

const [tool, build, code] = process.argv.slice(2);

if (!tool || !build || !code) {
    console.error("usage: bun tool-stub.ts <tool> <build-dir> <exit-code>");
    process.exit(2);
}

const write = reporter(tool, join(build, `tool-${tool}.json`), {});

await write({ ran: false, reason: `the tool exited ${code} without writing a report` });

console.log(`wrote a stub report for '${tool}', which exited ${code}`);
