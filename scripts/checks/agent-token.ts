/**
 * The step that starts the agent declares no GitHub credential.
 *
 * `/proc/<pid>/environ` holds what a process was started with for as long as it lives, and a
 * lens runs as the same user with `Bash`, so a token in this step's `env:` is a token a lens
 * reads however carefully the shell unsets it afterwards. review/DECISIONS.md, under "The
 * GitHub token never enters the step that runs the agent", has the measurement and what the
 * staging step does instead.
 *
 * A check rather than the comment that used to be the whole of it. Putting
 * `GITHUB_TOKEN: ${{ inputs.github-token }}` back is a one-line edit that looks like a
 * simplification — the staging step exists only to avoid it — and every gate stayed green
 * when it was tried here. CLAUDE.md's own rule is that prose is not a boundary.
 *
 * The step is found by what it does rather than by its name, so renaming it does not switch
 * the check off silently. Failing where no step runs the agent covers the other way round:
 * a rename of the script, or a run moved into a step this never reads.
 */

import { action, fail } from "./support.ts";
import type { Failures } from "./support.ts";

/** What the review step runs, and what a token reference looks like in a step's `env:`. */
const STARTS_THE_AGENT = "review/run.sh";
const CREDENTIAL = /github-token|GITHUB_TOKEN|claude-code-oauth-token/;

/** Its GitHub half, which no variable in that block may carry whatever it is called. */
const GITHUB_CREDENTIAL = /github-token|GITHUB_TOKEN/;

/**
 * What takes the runner's own copy of the inputs out of the step's shell.
 *
 * A step's `env:` is not the only way a credential reaches it. Where the runner passes a
 * composite action's inputs down as `INPUT_<NAME>`, both tokens arrive under names that are not
 * in the `env:` block, and this step's shell lives for the whole review with them in
 * /proc/<pid>/environ. Only an `exec` replaces that, and only in the shell that holds them:
 * calling it one level down, inside run.sh, leaves the parent exactly as it was.
 */
const SCRUBS_THE_INPUTS = "scrub_inputs";

/**
 * The accepted risk in CLAUDE.md covers this one, rather than this check. Its value is still
 * held to `GITHUB_CREDENTIAL`, or `CLAUDE_CODE_OAUTH_TOKEN: ${{ inputs.github-token }}` reaches
 * the same step by the same one-line edit.
 */
const HOLDS_A_CREDENTIAL = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Exempt on its name and not on its value. Exempting both passes
 * `GITHUB_TOKEN_FILE: ${{ inputs.github-token }}`, which is the one-line edit the header
 * above is about, under the one name this check permits.
 */
const HOLDS_A_PATH = "GITHUB_TOKEN_FILE";

export async function checkAgentToken(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await action(list);
    if (!manifest) return list;

    const steps = (manifest.runs?.steps ?? []).filter((step) => (step.run ?? "").includes(STARTS_THE_AGENT));

    if (steps.length === 0) {
        fail(list, "action.yml", `no step runs ${STARTS_THE_AGENT}, so nothing here checks what starts the agent`);
        return list;
    }

    for (const step of steps) {
        const named = step.env ?? {};

        // A call, not a mention. As a substring test this passed on a step whose `run:` only
        // named the function in a comment, which is the shape a reader most likely leaves
        // behind while moving the call somewhere it does not work.
        const calls = new RegExp(`^\\s*${SCRUBS_THE_INPUTS}\\s`, "m");

        if (!calls.test(step.run ?? "")) {
            fail(
                list,
                "action.yml",
                `step '${step.name ?? "unnamed"}' starts the agent without calling ${SCRUBS_THE_INPUTS}, ` +
                    "so the runner's own copy of every input stays in this shell's environment for the whole review.",
            );
        }

        for (const [key, value] of Object.entries(named)) {
            const exempt = key === HOLDS_A_CREDENTIAL || key === HOLDS_A_PATH;
            const pattern = key === HOLDS_A_CREDENTIAL ? GITHUB_CREDENTIAL : CREDENTIAL;

            const namesOne = !exempt && CREDENTIAL.test(key);
            const carriesOne = pattern.test(String(value));

            if (!namesOne && !carriesOne) continue;

            const how = carriesOne ? `passes a GitHub credential to '${key}'` : `names '${key}'`;

            fail(
                list,
                "action.yml",
                `step '${step.name ?? "unnamed"}' starts the agent and ${how} in its env:. ` +
                    "A lens reads that from /proc, so the token is staged in a file instead.",
            );
        }
    }

    if (list.length === 0) {
        console.log(
            `OK agent-token: ${steps.length} step(s) run ${STARTS_THE_AGENT}, each calling ${SCRUBS_THE_INPUTS}` +
                " and naming no GitHub credential in its env:",
        );
    }

    return list;
}
