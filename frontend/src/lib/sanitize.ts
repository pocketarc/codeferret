const ALLOWED = /^[\p{L}\p{N}\s.,:;!?'"()\-–—/@&%+]*$/u;

/**
 * Reduce an author-supplied string to characters that are safe to render as
 * text. Markup is removed rather than escaped, so the result is never HTML.
 */
export function sanitizeText(input: string): string {
    return input
        .split("\n")
        .map((line) => (ALLOWED.test(line) ? line : line.replace(/[<>&]/g, "")))
        .join("\n");
}
