/**
 * A Claude Code run log, and the questions a run's own numbers are read out of it.
 *
 * The shape of the log is upstream's, so each answer is narrowed rather than asserted: a
 * renamed field would otherwise come back as a confident zero with nothing saying the number
 * was not found, and a run that died is the one those numbers matter most for.
 *
 * Here rather than inside extract-findings.ts, for the reason finding-rules.ts gives: a rule in
 * a module is asserted without spawning a process and reading `cost-usd` back off disk.
 */

import { number, record, string } from "./json.ts";

/** The messages a log holds, and how many of its lines were not JSON at all. */
export interface RunLog {
    messages: unknown[];
    /**
     * Lines the fallback parse could not read.
     *
     * Counted rather than reported line by line: one message per bad line buried the numbers
     * printed under it, which are what somebody wants from a run that died.
     */
    unparsed: number;
}

function isResult(message: unknown): boolean {
    return record(message)?.type === "result";
}

/**
 * Every message in a run log, read whole-file first and line by line where that fails.
 *
 * A killed or out-of-memory session leaves the last line half written, which fails the
 * whole-file parse, so each line gets a `try` of its own rather than the run losing its
 * numbers to one exception.
 *
 * Where the fallback parses more than one `result`, none of them is used and every other message
 * goes with them, so `lastResult` answers null and the run ends with nothing extracted. That
 * rests on run.sh writing the log through `--output-format json`, which is one object: a complete
 * log parses in one piece, so the fallback only ever sees a file that was cut off, and a cut-off
 * file cannot hold two complete results. Under a streaming format the fallback would be the
 * ordinary path and this check would have to go with it. More than one result is bytes appended
 * past the end of a finished log, and the last of them is what `lastResult` would otherwise take
 * for the posted review. run.sh keeps that log on an unlinked descriptor for the length of the
 * session, so this backs that up rather than standing on its own.
 */
export function messagesOf(text: string): RunLog {
    try {
        const parsed: unknown = JSON.parse(text);

        return { messages: Array.isArray(parsed) ? parsed : [parsed], unparsed: 0 };
    } catch {
        const messages: unknown[] = [];
        let unparsed = 0;

        for (const line of text.split("\n")) {
            if (line.trim().length === 0) continue;

            try {
                messages.push(JSON.parse(line) as unknown);
            } catch {
                unparsed += 1;
            }
        }

        if (messages.filter(isResult).length > 1) {
            // Printed here rather than returned as a value. The one caller prints an unreadable
            // log as a session that produced no terminal output, and a maintainer reading that
            // about a log somebody wrote into could not tell the two apart.
            console.error(
                "the run log did not parse in one piece and holds more than one result line, which is what a log" +
                    " written into after the session looks like. None of them is being read.",
            );

            return { messages: [], unparsed };
        }

        return { messages, unparsed };
    }
}

/**
 * The last `result` message, which is the only complete one.
 *
 * The orchestrator emits a fresh structured output each time a lens reports back, so the log
 * holds several of these and every one before the last is a partial review.
 */
export function lastResult(messages: unknown[]): Record<string, unknown> | null {
    const results = messages.map(record).filter((m) => m !== null && m.type === "result");

    return results[results.length - 1] ?? null;
}

/**
 * What the run cost, across the three answers a log can give.
 *
 * A subscription-billed run has been seen to report `total_cost_usd` as zero while the
 * modelUsage figures said otherwise, and zero is the number a reader takes for a free $36
 * review on every surface this reaches. So a reported zero falls through to the sum, and only
 * an empty `modelUsage` falls back to it: `record({})` is not null, so testing for the object
 * rather than for its entries produces the confident 0.00 this exists to avoid.
 */
export function totalCost(reported: number | null, summed: number, models: number): number | null {
    if (reported) return reported;
    if (models > 0) return summed;

    // Null where the log carried neither, which is what a shape that has moved looks like.
    // A reported zero with nothing to sum stays zero.
    return reported;
}

/**
 * Why a run ended, out of the fields a failed result carries.
 *
 * `subtype` is not one of them, and a reader takes it for a clean exit. A session the API cut
 * off with a 429 reported `subtype: "success"`, so the first line a maintainer read after a
 * $4 run died was `the run reported an error: success`. What happened was in `terminal_reason`
 * and `api_error_status`, and the sentence to act on (`You've hit your session limit`) was in
 * `result`, and nothing printed any of the three.
 */
export function failureReason(result: Record<string, unknown>): string {
    const status = number(result.api_error_status) ?? string(result.api_error_status);
    const what = string(result.terminal_reason) ?? string(result.subtype) ?? "unknown";
    const named = status === null ? what : `${what}, HTTP ${status}`;

    // Bounded and folded onto one line. `result` carries whatever the API or the model wrote,
    // and a session that ended on a wall of prose would push everything reported below it off
    // the screen of whoever is reading the step log.
    const said = (string(result.result) ?? "").replace(/\s+/g, " ").trim().slice(0, 300);

    return said === "" ? named : `${named}: ${said}`;
}
