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

import { record } from "../../review/json.ts";
import { action, fail, inputLines, parseYaml } from "./support.ts";
import type { Failures } from "./support.ts";

/** The line that gives an end date to a lens this repository has switched off. */
const EXCLUSION_EXPIRES = /^[ \t]*#\s*Expires (\d{4}-\d{2}-\d{2})\b/gm;

/**
 * The comment lines directly above `key`, and nowhere else in the file.
 *
 * An expiry date is bound to the block it explains, not to whichever `# Expires` line the
 * file happens to contain first: unanchored, a date left behind by a rewritten block would
 * satisfy an exclusion it says nothing about.
 */
function commentAbove(raw: string, key: string): string {
    const lines = raw.split("\n");
    const keyLine = lines.findIndex((line) => line.trimStart().startsWith(key));
    if (keyLine === -1) return "";

    let start = keyLine;
    while (start > 0) {
        const prior = lines[start - 1];
        if (!prior?.trimStart().startsWith("#")) break;
        start--;
    }

    return lines.slice(start, keyLine).join("\n");
}

export async function checkWorkflowLenses(): Promise<Failures> {
    const list: Failures = [];
    const path = ".github/workflows/codeferret.yml";
    const manifest = await action(list);
    if (!manifest) return list;

    const parsed = record(await parseYaml(list, path));
    const job = record(record(parsed?.jobs)?.review);

    // Addressed by name rather than assumed present: a `review` job renamed or removed left
    // `steps` at `[]`, `dropped` at `[]`, and this check printed an OK line for an exclusion it
    // never looked at.
    if (!job) {
        fail(list, path, "declares no jobs.review, so its exclude-lenses cannot be checked against action.yml");
        return list;
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    const shipped = inputLines(list, "action.yml", "lenses", manifest.inputs?.lenses?.default);

    for (const step of steps) {
        const to = record(record(step)?.with);

        // Present at all, whatever it holds. `lines` gave an empty list for a key set to a
        // YAML sequence or to nothing, and the workflow went on replacing the default in
        // silence.
        if (to && "lenses" in to) {
            fail(list, path, "names `lenses`, which replaces the default. Subtract with `exclude-lenses` instead.");
        }

        for (const lens of inputLines(list, path, "exclude-lenses", to?.["exclude-lenses"])) {
            if (!shipped.includes(lens)) {
                fail(list, path, `excludes '${lens}', which action.yml no longer ships. Drop it, or fix the name.`);
            }
        }
    }

    const dropped = steps.flatMap((step) =>
        inputLines(list, path, "exclude-lenses", record(record(step)?.with)?.["exclude-lenses"]),
    );

    if (dropped.length > 0) {
        const block = commentAbove(await Bun.file(path).text(), "exclude-lenses:");
        const [date, ...extra] = [...block.matchAll(EXCLUSION_EXPIRES)].map((match) => match[1]);
        const today = new Date().toISOString().slice(0, 10);

        if (date === undefined) {
            fail(
                list,
                path,
                "switches a lens off with no `# Expires YYYY-MM-DD:` line directly above `exclude-lenses:`," +
                    " so nothing ever asks whether it should come back on",
            );
        } else if (extra.length > 0) {
            fail(
                list,
                path,
                `carries ${1 + extra.length} \`# Expires\` dates directly above \`exclude-lenses:\`,` +
                    " so which one governs the exclusion is ambiguous",
            );
        } else if (date < today) {
            fail(
                list,
                path,
                `switched ${dropped.join(" and ")} off until ${date}, which has passed.` +
                    " Turn them back on, or set a new date and say what changed.",
            );
        }
    }

    if (list.length === 0) console.log(`OK ${path}: the shipped default minus ${dropped.length}`);

    return list;
}
