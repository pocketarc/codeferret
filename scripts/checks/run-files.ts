/**
 * The run files action.yml reads back, against the names the scripts write them under.
 *
 * action.yml cannot import `RUN_FILES`, so its `emit_output_file` calls spell each name out
 * a second time. Rename one side and the summary and the step outputs report `unknown` for a
 * $36 review, which is exactly what a session killed halfway looks like.
 *
 * Not a pair a generator could collapse, which is what became of the artifact name and the
 * retention window. YAML cannot read a TypeScript constant, and the shell that would write
 * one of these into a step output is the shell inside action.yml.
 */

import { DISPATCHED_FILE, RUN_FILE_NAMES, RUN_FILES, SESSION_CHANGED_FILE } from "../../review/run-files.ts";
import { action, fail } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkRunFiles(): Promise<Failures> {
    const list: Failures = [];
    const manifest = await action(list);
    if (!manifest) return list;

    const shell = (manifest.runs?.steps ?? []).map((step) => step.run ?? "").join("\n");
    const named = [...shell.matchAll(/^\s*emit_output_file\s+(\S+)\s+"\$out\/(\S+?)"/gm)];

    if (named.length === 0) {
        fail(list, "action.yml", "makes no `emit_output_file` call, so no run file reaches a step output");
        return list;
    }

    for (const [, output, file] of named) {
        if (!RUN_FILE_NAMES.includes(String(file))) {
            fail(list, "action.yml", `output '${output}' reads '${file}', which review/run-files.ts does not name`);
        }
    }

    // `finalise.ts` writes the marker and `require_checked_findings` in lib.sh reads it back,
    // and those two agree by importing the name from review/run-files.ts, which is a stronger
    // binding than a text search. What the search still covers is the shell either side of
    // them: `run.sh` clears the marker before the session and lib.sh gates the local paths on
    // it, and neither can import. Drift there is the quietest failure the action has — the
    // marker goes down under a name the posting step's condition does not test, so a review is
    // produced, paid for, and never posted, with nothing red anywhere.
    for (const script of ["review/run.sh", "review/lib.sh"]) {
        if (!(await Bun.file(script).text()).includes(RUN_FILES.findingsChecked)) {
            fail(list, script, `never names '${RUN_FILES.findingsChecked}', which is what the action posts on`);
        }
    }

    // The same fact for the file a run's dispatched lenses are read back from. No TypeScript
    // writes it either, and `readDispatched` answers a missing one with an empty list, which
    // is indistinguishable from a run in which every lens reported: rename it on one side and
    // `coverageOf` silently stops reporting a lens that ran and said nothing about itself.
    // Naming the file is the whole of what the two sides have to agree on now that the format
    // is one bare name per line.
    const prompts = "review/build-prompts.sh";

    if (!(await Bun.file(prompts).text()).includes(`$BUILD/${DISPATCHED_FILE}`)) {
        fail(list, prompts, `never writes '${DISPATCHED_FILE}', which is where a run's dispatched lenses are read from`);
    }

    // And the same again for the changed-input report, where a rename fails silently:
    // `readSessionChanged` answers a missing file exactly as it answers a run in which
    // nothing moved.
    const runner = "review/run.sh";

    if (!(await Bun.file(runner).text()).includes(`$BUILD/${SESSION_CHANGED_FILE}`)) {
        fail(list, runner, `never writes '${SESSION_CHANGED_FILE}', which is where a changed input is reported from`);
    }

    if (list.length === 0) console.log(`OK run-files: ${named.length} step output(s) name a file the run writes`);

    return list;
}
