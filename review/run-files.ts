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
import { lines } from "./lines.ts";

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

/**
 * Where build-prompts.sh writes the lenses it dispatched, one `<namespace>:<lens>` per line.
 *
 * A second file beside `lens-list.txt`, which holds the same names as markdown bullets for
 * the orchestrator's prompt. One file serving both meant a prompt fragment's decoration was
 * also a wire format two languages had to agree on, and drift was silent in the direction
 * that matters: a changed bullet leaves `dispatchedFrom` returning nothing, `coverageOf`
 * stops reporting a lens that ran and said nothing about itself, and check-findings.ts goes
 * on printing `shape valid`. Holding the two together took a check in validate-repo.ts that
 * read the `printf` format out of the shell and re-implemented printf to render it. Splitting
 * them costs one more `printf`, removes all of that, and leaves the prompt's wording free to
 * change again.
 */
export const DISPATCHED_FILE = "lenses.txt";

/** The lenses a run dispatched, out of that file's text. */
export function dispatchedFrom(text: string): string[] {
    return lines(text);
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
    const file = Bun.file(join(dir, DISPATCHED_FILE));

    return (await file.exists()) ? dispatchedFrom(await file.text()) : [];
}
