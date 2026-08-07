#!/usr/bin/env bun
/**
 * The report a tool that died before reaching its own reporter never wrote.
 *
 * The `static-analysis` lens accounts for what it was handed, so a tool that left no file
 * leaves no trace in the review at all. This gives the lens something to read.
 *
 * Not under `review/tools/`, because run.sh will run anything named there as a tool.
 *
 * Usage: bun tool-stub.ts <tool> <build-dir> <exit-code>
 */

import { reporter, reportPath } from "./tools/report.ts";

const [tool, build, code] = process.argv.slice(2);

if (!tool || !build || !code) {
    console.error("usage: bun tool-stub.ts <tool> <build-dir> <exit-code>");
    process.exit(2);
}

const out = reportPath(tool, build);

// Whether a stub is needed is decided here rather than by run.sh, which cannot import
// `reportPath` and would have to spell the filename out a second time. A tool that reached
// its own reporter has already said more about what it did than a stub could.
if (await Bun.file(out).exists()) {
    console.log(`'${tool}' wrote its own report, so no stub was needed`);
    process.exit(0);
}

const write = reporter(tool, out, {});

await write({ ran: false, reason: `the tool exited ${code} without writing a report` });

console.log(`wrote a stub report for '${tool}', which exited ${code}`);
