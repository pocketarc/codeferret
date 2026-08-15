/**
 * The narrowings every script here takes on a value it did not produce.
 *
 * A run's scripts read JSON a model wrote and JSON an artifact carried, and they are
 * written to fail soft, so a value of the wrong shape has to be caught where it is read
 * rather than where it is used.
 *
 * The scalar narrowings sit beside `record` because a module that writes its own is where the
 * next private copy comes from: extract-findings.ts kept a `number` and a `string` of its own,
 * and previous.ts spelled the integer test out inline wherever it needed one.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value whose fields can be read, or null.
 *
 * Without this a caller reads every field off a null or an array as `undefined` and carries
 * on as though the shape were right.
 */
export function record(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

/**
 * A number that arithmetic can be done on, or null.
 *
 * `Number.isFinite` and not `typeof` alone: `NaN` and `Infinity` are numbers, and either one
 * summed into a run's cost renders as `NaN` on every surface that reports it.
 */
export function number(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A whole number, or null. Line numbers, ids and counts are all read through this. */
export function integer(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** A string, or null. */
export function string(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

/** What went wrong, as a line a reader can act on. */
export function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
