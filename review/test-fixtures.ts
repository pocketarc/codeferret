/**
 * The one finding the suites build their cases out of, in the two shapes they need.
 *
 * `merged-schema.json` is the contract all of them model, and it was modelled five times: a
 * copy in each suite, disagreeing about defaults, so a field the schema started requiring
 * reached whichever files somebody remembered. One copy means a schema change breaks one
 * file.
 *
 * Two builders rather than one, because the suites are of two kinds. Anything that reads a
 * finding takes a `Finding`, and the compiler has to say so. Anything that decides whether a
 * finding is well formed has to be handed one that is not, which a typed builder cannot
 * express, so `rawFinding` returns a plain record and its callers put what they like in it.
 */

import type { Finding } from "./findings.ts";

/** A valid finding, for the code that reads one. */
export function finding(over: Partial<Finding> = {}): Finding {
    return {
        file: "a.ts",
        line: 1,
        severity: "low",
        category: "style",
        title: "A title",
        body: "A body.",
        ...over,
    };
}

/** The same finding untyped, for the code that decides whether one is well formed. */
export function rawFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        found_by: ["caveman-review"],
        file: "a.ts",
        line: 4,
        severity: "high",
        category: "correctness",
        title: "A title",
        body: "A body.",
        status: "new",
        ...over,
    };
}
