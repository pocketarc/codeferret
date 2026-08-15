#!/usr/bin/env bun
/**
 * What `artifact-path` names, as the two answers the action's upload and posting steps need.
 *
 * One string in, two out, and both about the same input: the path `upload-artifact` is given,
 * and whether what goes up carries the findings file. The second decides how the review body
 * is written. With the findings one download away it prints the critical and high ones and
 * names the artifact for the rest; with nothing behind it every finding goes in the comment.
 * So an input answered one way for the upload and another way for the body gives a consumer a
 * review that leaves most of its findings out and links a file nobody kept.
 *
 * Here rather than in action.yml, where this was three `case` statements inside a YAML string
 * that nothing but shellcheck could reach, and shellcheck reads syntax. The syntax was never
 * wrong: `./findings.json` was read as keeping the findings while producing a path
 * `upload-artifact` refuses, which is the defect the `./` stripping below was added for. As a
 * function it has a table of cases in `bun test`, which is where that defect would have shown
 * up the day it was written.
 *
 * Usage: bun artifact-path.ts <artifact-path> <build-dir>
 *
 * Prints the path on the first line and `true` or `false` on the second, because the caller
 * reads them with two `read`s. Neither value can carry a newline: one is refused below and
 * the other is a literal.
 *
 * Exit: 0 resolved, 1 refused with a reason on stderr, 2 nothing given to resolve.
 */

/** Where the findings a run produced are written, which is the file the next run reads back. */
const FINDINGS_FILE = "findings.json";

export interface Kept {
    /** What `upload-artifact` is given, absolute. */
    path: string;
    /** Whether `findings.json` is inside it. */
    keepsFindings: boolean;
}

/** Refused rather than resolved. Thrown so a caller cannot read a refusal as an answer. */
export class ArtifactPathRefused extends Error {}

/**
 * The two answers, or a refusal.
 *
 * The refusals are `upload-artifact`'s own limits, checked here so a bad input fails a job in
 * its first seconds rather than after a review that took twenty minutes and cost real money.
 * A `..` segment escapes the build directory; a `.` segment is a pattern the upload refuses
 * outright, and every segment of what it receives is past the front because the build
 * directory is prepended; and a newline is a second path uploaded, because `path` is read as a
 * newline-separated list and nothing in the run would say so.
 *
 * `./x` and `x` name one file, so the leading `./` comes off in one place. Stripped once
 * rather than matched again in each branch below: matching it twice is how the two answers
 * came to disagree about `./findings.json`.
 */
export function resolveArtifactPath(input: string, buildDir: string): Kept {
    if (input.includes("\n")) {
        throw new ArtifactPathRefused("artifact-path must be a single path");
    }

    const segments = input.split("/");

    if (segments.includes("..")) {
        throw new ArtifactPathRefused(`artifact-path must stay inside the build directory: ${input}`);
    }

    // A leading one is stripped just below; any other is refused. `.` and `./` on their own
    // are the documented way to ask for the whole directory, and fall through to the answers
    // below.
    if (segments.slice(1).includes(".")) {
        throw new ArtifactPathRefused(`artifact-path must name no '.' directory: ${input}`);
    }

    const named = input === "." || input === "./" ? "" : input.replace(/^\.\//, "");

    if (named === "") return { path: buildDir, keepsFindings: true };

    return { path: `${buildDir}/${named}`, keepsFindings: named === FINDINGS_FILE };
}

if (import.meta.main) {
    const [input, buildDir] = process.argv.slice(2);

    if (input === undefined || input === "" || !buildDir) {
        console.error("usage: bun artifact-path.ts <artifact-path> <build-dir>");
        process.exit(2);
    }

    try {
        const kept = resolveArtifactPath(input, buildDir);

        console.log(kept.path);
        console.log(kept.keepsFindings ? "true" : "false");
    } catch (error) {
        console.error(error instanceof ArtifactPathRefused ? error.message : String(error));
        process.exit(1);
    }
}
