/**
 * The names a run writes beside the findings file, and the single line format read back out
 * of them.
 *
 * Each is protocol between a script that writes it and a reader that never sees that script:
 * extract-findings.ts writes them, summary.ts reads them back off disk, and action.yml turns
 * some of them into step outputs. Every reader treats an absent file as `unknown`, which is
 * also what those scripts write for a session that died, so after a rename on one side the
 * summary reports a $36 review as `unknown`, which looks exactly like the failure these
 * files exist to make visible.
 *
 * `run_dirs` in lib.sh is the same fact one level up, and diff-args.ts is the same fact about
 * the range. validate-repo.ts checks action.yml's names against this set, because that file
 * cannot import it.
 */
import { join } from "node:path";

export const RUN_FILES = {
    findingsCount: "findings-count",
    cost: "cost-usd",
    outputTokens: "output-tokens",
    durationMs: "duration-ms",
    permissionDenials: "permission-denials",
    /** Written by run.sh rather than by a script here, and the condition the action posts on. */
    findingsChecked: "findings-checked",
} as const;

/** Every name above, for a caller that has to see the set rather than one member. */
export const RUN_FILE_NAMES: readonly string[] = Object.values(RUN_FILES);

/** Where build-prompts.sh writes the lenses it dispatched, for the orchestrator's prompt. */
export const LENS_LIST_FILE = "lens-list.txt";

/**
 * One line of that file: a markdown bullet holding `<namespace>:<lens>`.
 *
 * The file is a fragment of a prompt, so the decoration is not ours to drop. What is ours is
 * that build-prompts.sh writes this line with `printf` and `dispatchedFrom` reads it back
 * with this pattern, in two languages. It is named here, and validate-repo.ts runs the
 * shell's own line and checks that this pattern recovers what it wrote. Left in two homes
 * with nothing checking the pair, a changed format returns no lenses at all: `coverageOf` no
 * longer reports a lens that ran and said nothing about itself, and check-findings.ts still
 * prints `shape valid`.
 */
export const LENS_LIST_LINE = /^- `([^`]+)`$/;

/** The lenses a run dispatched, out of that file's text. */
export function dispatchedFrom(text: string): string[] {
    return text.split("\n").flatMap((line) => line.match(LENS_LIST_LINE)?.[1] ?? []);
}

/**
 * The lenses a run dispatched, out of the run directory.
 *
 * Empty where the file is not there, which is a review checked or posted by hand from a
 * findings file somebody copied. Nothing here fails on that: what the list buys is a report
 * of a lens that ran and said nothing about itself, and a run whose list is gone has nothing
 * to compare against either way.
 */
export async function readDispatched(dir: string): Promise<string[]> {
    const file = Bun.file(join(dir, LENS_LIST_FILE));

    return (await file.exists()) ? dispatchedFrom(await file.text()) : [];
}
