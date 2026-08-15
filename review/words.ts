/**
 * The inflection a review's own sentences need.
 *
 * Here rather than in review-body.ts because `caveats.ts` writes sentences the terminal
 * renderer prints as well, and a module of sentences that had to import review-body.ts to
 * inflect a noun would put the two in a cycle.
 */

/**
 * A count and its noun.
 *
 * Only the noun is inflected, so the phrase around it has to read at either count: "1
 * finding were raised" is what a hard-coded plural verb next to one of these produces.
 */
export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The one noun in the review that does not take an `s`. */
export function lenses(n: number): string {
    return n === 1 ? "1 lens" : `${n} lenses`;
}
