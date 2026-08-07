/**
 * The names a run writes its own numbers under, beside the findings file.
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
