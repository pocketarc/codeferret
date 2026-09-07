import { number, record, string } from "./json.ts";
import { RUN_FILES, type RunNumberFile } from "./run-files.ts";

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
 * Both runners emit a complete JSON document. Multiple result lines in an unparseable
 * document indicate appended content; accepting the last could replace the posted review.
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
 * Claude can emit partial results as lenses report back; only the last is complete.
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

/** What one model spent, narrowed out of the log's own `modelUsage` entry. */
export interface ModelSpend {
    model: string;
    outputTokens: number;
    costUSD: number;
}

/** Everything a run reports about itself, before any of it has been turned into a file. */
export interface RunNumbers {
    perModel: ModelSpend[];
    /**
     * Null where the log carries no usage at all, rather than 0.
     *
     * `0` is a measurement, and a summary reading "Cost: unknown" beside "Output tokens: 0" is
     * two answers to the same question.
     */
    outputTokens: number | null;
    costUsd: number | null;
    durationMs: number | null;
    /** Null where the log carries no denial list at all, which is not evidence nothing was refused. */
    refusals: number | null;
    /** Each refusal as the log wrote it, for the report that names what a lens could not run. */
    denials: Record<string, unknown>[];
}

/**
 * Claude's `usage` covers only the orchestrator's last turn; `modelUsage` includes subagents.
 */
export function runNumbers(last: Record<string, unknown>): RunNumbers {
    const models = record(last.modelUsage);

    const perModel: ModelSpend[] = Object.entries(models ?? {}).map(([model, usage]) => {
        const narrowed = record(usage);

        return {
            model,
            outputTokens: number(narrowed?.outputTokens) ?? 0,
            costUSD: number(narrowed?.costUSD) ?? 0,
        };
    });

    const summed = perModel.reduce((total, spend) => total + spend.costUSD, 0);

    const refused = Array.isArray(last.permission_denials) ? last.permission_denials : null;

    // Narrowed element by element, not just as a container. This list is read by the report at
    // the end of a run, after the findings file is on disk, and a null or a string in it would
    // turn a complete run into a stack trace over the one report saying what a lens was refused.
    const denials = (refused ?? []).map(record).filter((entry) => entry !== null);

    return {
        perModel,
        outputTokens: last.engine === "codex"
            ? number(record(last.usage)?.output_tokens)
            : perModel.length === 0 ? null : perModel.reduce((total, spend) => total + spend.outputTokens, 0),
        costUsd: totalCost(number(last.total_cost_usd), summed, perModel.length),
        durationMs: number(last.duration_ms),
        // The whole list, not the entries this file could read. An entry it could not read is
        // still a refusal, and counting the survivors under-reports the number `summary.ts`
        // raises its refusal warning off, which is the direction that hides a narrowed review.
        refusals: refused?.length ?? null,
        denials,
    };
}

/**
 * Those numbers as the run files carry them, one line each.
 *
 * The set is the contract, not any one name, so the whole record is built here and the caller
 * writes what it is given. To every reader an absent file is indistinguishable from a zero, and
 * `unknown` is what a killed session writes, so a file added on one path and forgotten on the
 * other is taken for a killed session on a run that worked.
 */
export function reportedNumbers(numbers: RunNumbers, findings: unknown[] | null): Record<RunNumberFile, string> {
    const said = (value: number | null): string => (value === null ? "unknown" : String(value));

    return {
        [RUN_FILES.findingsCount]: findings === null ? "none reported" : String(findings.length),
        [RUN_FILES.cost]: numbers.costUsd === null ? "unknown" : numbers.costUsd.toFixed(2),
        [RUN_FILES.outputTokens]: said(numbers.outputTokens),
        [RUN_FILES.durationMs]: said(numbers.durationMs),
        [RUN_FILES.permissionDenials]: said(numbers.refusals),
    };
}
