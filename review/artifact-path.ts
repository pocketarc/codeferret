#!/usr/bin/env bun
/**
 * What `artifact-path` names, as the two answers the action's upload and posting steps need.
 *
 * One input, two answers, and both about the same value: the paths `upload-artifact` is
 * given, and whether what goes up carries the findings file. The second decides how the
 * review body is written. With the findings one download away it prints the critical and high
 * ones and names the artifact for the rest; with nothing behind it every finding goes in the
 * comment. So an input answered one way for the upload and another way for the body gives a
 * consumer a review that leaves most of its findings out and links a file nobody kept.
 *
 * Here rather than in action.yml, where this was three `case` statements inside a YAML string
 * that nothing but shellcheck could reach, and shellcheck reads syntax. The syntax was never
 * wrong: `./findings.json` was read as keeping the findings while producing a path
 * `upload-artifact` refuses, which is the defect `normalise` below was added for. As a
 * function it has a table of cases in `bun test`, which is where that defect would have shown
 * up the day it was written.
 *
 * Usage: bun artifact-path.ts <artifact-path> <build-dir>
 *
 * Prints `true` or `false` on the first line and one absolute path per line after it. That
 * order because the list is the part that can run to several lines: the caller reads the
 * first line with `read` and the rest with `cat`.
 *
 * Exit: 0 resolved, 1 refused with a reason on stderr, 2 nothing given to resolve.
 */

import { lines } from "./lines.ts";

/** Where the findings a run produced are written, which is the file the next run reads back. */
const FINDINGS_FILE = "findings.json";

export interface Kept {
    /** What `upload-artifact` is given, one absolute path per entry. */
    paths: string[];
    /** Whether `findings.json` is inside what goes up. */
    keepsFindings: boolean;
}

/** Refused rather than resolved. Thrown so a caller cannot read a refusal as an answer. */
export class ArtifactPathRefused extends Error {}

/**
 * One entry, with the spellings that name the same file reduced to one form.
 *
 * The module's whole premise is that the comparison against `findings.json` is made once
 * against a normalised value, and it was not: stripping a single leading `./` left
 * `.//findings.json` and `findings.json/` resolving to the findings file for the upload while
 * answering `false` for the body. Repeated and trailing slashes go, then every leading `./`,
 * and the result is `""` for the spellings that name the build directory itself.
 */
function normalise(entry: string): string {
    const collapsed = entry.replace(/\/+/g, "/").replace(/\/+$/, "");

    return collapsed.replace(/^(\.\/)+/, "").replace(/^\.$/, "");
}

/**
 * The characters that make an entry a pattern rather than a name.
 *
 * `upload-artifact` reads `path` through `@actions/glob`, so any of these decides what goes
 * up by matching rather than by naming, and this module cannot then say whether the findings
 * file is among what goes up. `*` used to answer `false` and take the findings up anyway, which
 * costs a comment carrying every finding beside an artifact that already held them; answering
 * `true` wrongly costs a review that links a file nobody kept, which is the defect this module
 * exists to prevent. A leading `!` is the exclusion form and belongs with them: it takes paths
 * back out of a list rather than adding one.
 */
const PATTERN_CHARS = /[*?[\]{}]/;

/**
 * The two answers, or a refusal.
 *
 * The refusals are `upload-artifact`'s own limits and this module's own, checked here so a bad
 * input fails a job in its first seconds rather than after a review that took twenty minutes
 * and cost real money. A `..` segment escapes the build directory, and a `.` segment is a
 * pattern the upload refuses outright: every segment of what it receives is past the front,
 * because the build directory is prepended. An absolute path and a glob are this module's own,
 * and each has its reason written beside it.
 *
 * The input is a list, because `upload-artifact` reads `path` as one and the whole point of
 * this repository's own narrowing is naming files rather than a directory. A YAML block
 * scalar is how a workflow author writes one, and it leaves the indentation on and a trailing
 * newline behind, so `lines` is what reads it.
 */
export function resolveArtifactPath(input: string, buildDir: string): Kept {
    const named = lines(input).map(normalise);

    if (named.length === 0) {
        throw new ArtifactPathRefused("artifact-path names no path. Leave it empty to upload nothing.");
    }

    // The documented way to ask for the whole directory, and it makes every other entry
    // redundant rather than wrong. Refused among others so that nobody reads a short list of
    // files as the bound on what goes up when one line of it is all of them.
    if (named.includes("")) {
        if (named.length === 1) return { paths: [buildDir], keepsFindings: true };

        throw new ArtifactPathRefused(`artifact-path names '.' alongside other paths, and '.' is already all of them: ${input}`);
    }

    for (const entry of named) {
        const segments = entry.split("/");

        if (segments.includes("..")) {
            throw new ArtifactPathRefused(`artifact-path must stay inside the build directory: ${entry}`);
        }

        if (segments.includes(".")) {
            throw new ArtifactPathRefused(`artifact-path must name no '.' directory: ${entry}`);
        }

        // Every entry is resolved against the build directory, so a leading slash is somebody
        // asking for a path this cannot give them. It used to be prepended anyway, and
        // `/findings.json` then uploaded the findings under a doubled slash while answering
        // `false` for the body.
        if (entry.startsWith("/")) {
            throw new ArtifactPathRefused(
                `artifact-path is resolved against the build directory, so it takes no absolute path: ${entry}`,
            );
        }

        if (PATTERN_CHARS.test(entry) || entry.startsWith("!")) {
            throw new ArtifactPathRefused(`artifact-path names a file rather than a pattern: ${entry}`);
        }
    }

    // Deduplicated, because two spellings of one file are one file to `upload-artifact` and
    // repeating it in the list says something the run does not mean.
    const unique = [...new Set(named)];

    return {
        paths: unique.map((entry) => `${buildDir}/${entry}`),
        keepsFindings: unique.includes(FINDINGS_FILE),
    };
}

if (import.meta.main) {
    const [input, buildDir] = process.argv.slice(2);

    if (input === undefined || !buildDir) {
        console.error("usage: bun artifact-path.ts <artifact-path> <build-dir>");
        process.exit(2);
    }

    try {
        const kept = resolveArtifactPath(input, buildDir);

        console.log(kept.keepsFindings ? "true" : "false");
        console.log(kept.paths.join("\n"));
    } catch (error) {
        console.error(error instanceof ArtifactPathRefused ? error.message : String(error));
        process.exit(1);
    }
}
