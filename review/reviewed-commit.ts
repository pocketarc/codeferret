#!/usr/bin/env bun
/**
 * Print the commit the lenses reviewed, read out of the run's `diff-args`.
 *
 * A review is recorded against a commit, and every line a finding names is a line of that
 * one. `local-post.sh` and the action's post step both need it.
 *
 * Usage: bun reviewed-commit.ts <diff-args>
 *
 * Exit: 1 when the run reviewed the working tree, which is no commit to post against.
 */

import { readDiffArgs, reviewedCommit } from "./diff-args.ts";

const [argsFile] = process.argv.slice(2);

if (!argsFile) {
    console.error("usage: bun reviewed-commit.ts <diff-args>");
    process.exit(2);
}

const { range } = await readDiffArgs(argsFile);
const commit = reviewedCommit(range);

if (!commit) {
    console.error(`this run reviewed the working tree, not a commit ('${range}').`);
    console.error("a review is recorded against a commit, so there is nothing to post against.");
    process.exit(1);
}

console.log(commit);
