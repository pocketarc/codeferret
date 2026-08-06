/**
 * The two narrowings every script here takes on a value it did not produce.
 *
 * A run's scripts read JSON a model wrote and JSON an artifact carried, and they are
 * written to fail soft, so a value of the wrong shape has to be caught where it is read
 * rather than where it is used.
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
 * What went wrong, as a line a reader can act on.
 *
 * A line like this is often the only sign that anything went wrong. One function, so every
 * caller words it the same way and none of them loses the message from something thrown
 * that is not an `Error`.
 */
export function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
