/**
 * What this repository's own workflow says about the lenses it runs.
 *
 * It used to restate the shipped default minus two, which nothing could keep in step: a lens
 * removed from action.yml and left there failed `build-prompts.sh` seconds into a run, and a
 * lens *added* to action.yml and not there was silent for ever, the review covering less than
 * the default and saying nothing about it. Forty lines here reconciled the copy in both
 * directions against a map naming the two exceptions.
 *
 * `exclude-lenses` states the intent instead, and subtraction cannot go stale when the
 * default grows. What is left to check is that the workflow has not gone back to a copy, and
 * that each name it subtracts is one action.yml still ships: a stale exclusion runs a lens
 * this repository decided not to run, and `run.sh` only says so on the job's stderr.
 *
 * And that the exclusion has an end. A lens switched off with a reason attached is one a
 * later reader leaves alone, because the reason is still true on its face and nothing is
 * scheduled to ask again. The date the workflow carries is what asks: it fails this check
 * once that date has gone by, which is the only mechanism here that can make somebody weigh
 * the exclusion a second time.
 */

import { lines } from "../../review/lines.ts";
import { record } from "../../review/json.ts";
import { action, fail, parseYaml } from "./support.ts";
import type { Failures } from "./support.ts";

/** The line that gives an end date to a lens this repository has switched off. */
const EXCLUSION_EXPIRES = /^\s*#\s*Expires (\d{4}-\d{2}-\d{2})\b/m;

export async function checkWorkflowLenses(): Promise<Failures> {
    const list: Failures = [];
    const path = ".github/workflows/codeferret.yml";
    const manifest = await action(list);
    if (!manifest) return list;

    const parsed = record(await parseYaml(list, path));
    const job = record(record(parsed?.jobs)?.review);
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const shipped = lines(manifest.inputs?.lenses?.default);

    for (const step of steps) {
        const to = record(record(step)?.with);

        if (lines(to?.lenses).length > 0) {
            fail(list, path, "names `lenses`, which replaces the default. Subtract with `exclude-lenses` instead.");
        }

        for (const lens of lines(to?.["exclude-lenses"])) {
            if (!shipped.includes(lens)) {
                fail(list, path, `excludes '${lens}', which action.yml no longer ships. Drop it, or fix the name.`);
            }
        }
    }

    const dropped = steps.flatMap((step) => lines(record(record(step)?.with)?.["exclude-lenses"]));

    if (dropped.length > 0) {
        const on = (await Bun.file(path).text()).match(EXCLUSION_EXPIRES)?.[1];
        const today = new Date().toISOString().slice(0, 10);

        if (!on) {
            fail(
                list,
                path,
                "switches a lens off with no `# Expires YYYY-MM-DD:` line above it," +
                    " so nothing ever asks whether it should come back on",
            );
        } else if (on < today) {
            fail(
                list,
                path,
                `switched ${dropped.join(" and ")} off until ${on}, which has passed.` +
                    " Turn them back on, or set a new date and say what changed.",
            );
        }
    }

    if (list.length === 0) console.log(`OK ${path}: the shipped default minus ${dropped.length}`);

    return list;
}
