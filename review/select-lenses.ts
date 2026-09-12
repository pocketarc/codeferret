#!/usr/bin/env bun
/**
 * The lenses a run dispatches: the list it was given, minus the ones it was asked to drop.
 *
 * Subtraction, so that a caller wanting the shipped set minus one need not restate the rest.
 * A restated list is a copy, and a copy goes stale the day a lens is added to the default,
 * with the only symptom a review covering less than it says it does.
 *
 * Here rather than in run.sh, where this was a `trim`, a `while read` loop and a `grep -vxF`
 * that between them decided which lenses a run dispatches, with nothing testing any of it:
 * `bun test` covers no shell. The cost is on the record. `c271996` fixed one row of this
 * table: an empty `exclude-lenses`, which is the shipped default, arrived as a lens name of
 * `""`, `plain_name` refused it, and every consumer run died before the prompts were built.
 * That is a single case in `select-lenses.test.ts` and it reached shipped configuration
 * instead. `review/artifact-path.ts` and `review/diff-args.ts` are the same move.
 *
 * Usage: bun select-lenses.ts <lenses> <exclude-lenses>
 *
 * Prints one lens name per line, which is what `build-prompts.sh` reads on stdin.
 *
 * Exit: 0 selected, 1 refused with a reason on stderr, 2 nothing given to select.
 */

import { lines } from "./lines.ts";

/**
 * A lens name, held to `plain_name` in review/lib.sh.
 *
 * The copy is deliberate and narrow. A name reaching this file is only ever compared against
 * another name, so nothing here turns one into a path; `build-prompts.sh` runs the shell
 * `plain_name` over every name that survives, and that is where the rule binds. What the test
 * here buys is that a caller who mistyped an exclusion is told so, rather than getting the
 * "matched nothing" line that a real removal upstream also produces.
 */
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;

function plainName(name: string): boolean {
    return PLAIN_NAME.test(name) && !name.startsWith(".");
}

/** What a run dispatches, and which exclusions had nothing to subtract. */
export interface Selected {
    kept: string[];
    /**
     * Exclusions that matched no lens, reported rather than failed on.
     *
     * The list they subtract from is somebody else's to change, and a lens dropped upstream
     * would otherwise fail every job that had asked not to run it. Running one lens more than
     * intended is noisier, not quieter, which is the direction to be wrong in here.
     */
    unmatched: string[];
}

/** Refused rather than selected. Thrown so a caller cannot read a refusal as an answer. */
export class LensNameRefused extends Error {}

/**
 * The lenses left after the exclusions, and the exclusions that matched nothing.
 *
 * Both sides go through `lines`, because the match has to be a whole line: without the trim
 * an indented name would be compared as written here and read trimmed by
 * `build-prompts.sh`, and the run would report the exclusion as matching nothing while the
 * lens ran.
 */
export function selectLenses(lenses: string, exclude: string): Selected {
    let kept = lines(lenses);
    const unmatched: string[] = [];

    for (const drop of lines(exclude)) {
        if (!plainName(drop)) {
            throw new LensNameRefused(`exclude-lenses holds '${drop}', which is not a plain lens name.`);
        }

        const left = kept.filter((lens) => lens !== drop);

        if (left.length === kept.length) unmatched.push(drop);

        kept = left;
    }

    return { kept, unmatched };
}

if (import.meta.main) {
    const [lenses, exclude] = process.argv.slice(2);

    if (lenses === undefined || lenses.trim() === "") {
        console.error("usage: bun select-lenses.ts <lenses> <exclude-lenses>");
        process.exit(2);
    }

    try {
        const { kept, unmatched } = selectLenses(lenses, exclude ?? "");

        for (const name of unmatched) {
            console.error(`exclude-lenses names '${name}', which this run was not going to use anyway.`);
        }

        if (kept.length === 0) {
            console.error("exclude-lenses removed every lens, so there is nothing left to review with.");
            process.exit(1);
        }

        console.log(kept.join("\n"));
    } catch (error) {
        console.error(error instanceof LensNameRefused ? error.message : String(error));
        process.exit(1);
    }
}
