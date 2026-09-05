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

import { AXIS_NAMES, NOT_APPLICABLE, score, tierOf } from "./risk.ts";
import type { Risk, Tier } from "./risk.ts";
import type { Finding } from "./findings.ts";

/**
 * Risk answers that land a finding in the tier a case is about.
 *
 * A test that wants a critical finding wants one because of where it sorts or whether the
 * body prints it, not because of what it is made of, and spelling twelve axes out at each
 * such case would bury that. `riskFor` is asserted to produce the tier it names, so a weight
 * change that moves a band fails here rather than silently retuning every suite that
 * depends on one.
 */
const SHAPES: Record<Tier, Partial<Risk>> = {
    critical: {
        impact: "catastrophic",
        data_exposure: "regulated",
        blast_radius: "system",
        reversibility: "irreversible",
        detectability: "silent",
        availability: "outage",
        contract: "standard",
        likelihood: "certain",
        confidence: "confirmed",
        privileges_required: "none",
        attack_vector: "network",
        timing: "live",
    },
    high: {
        impact: "serious",
        data_exposure: "personal",
        blast_radius: "all-users",
        reversibility: "costly",
        detectability: "silent",
        availability: "none",
        contract: "standard",
        likelihood: "certain",
        confidence: "confirmed",
        privileges_required: "user",
        attack_vector: "network",
        timing: "live",
    },
    medium: {
        impact: "moderate",
        data_exposure: "internal",
        blast_radius: "tenant",
        reversibility: "costly",
        detectability: "delayed",
        availability: "degradation",
        contract: "house-rule",
        likelihood: "likely",
        confidence: "probable",
        privileges_required: "user",
        attack_vector: "network",
        timing: "live",
    },
    low: {
        impact: "minor",
        data_exposure: "none",
        blast_radius: "single-user",
        reversibility: "reversible",
        detectability: "delayed",
        availability: "none",
        contract: "house-rule",
        likelihood: "likely",
        confidence: "confirmed",
        privileges_required: "user",
        attack_vector: "network",
        timing: "live",
    },
    nit: {
        impact: "none",
        data_exposure: "none",
        blast_radius: "none",
        reversibility: NOT_APPLICABLE,
        detectability: NOT_APPLICABLE,
        availability: NOT_APPLICABLE,
        contract: "none",
        likelihood: "certain",
        confidence: "confirmed",
        privileges_required: NOT_APPLICABLE,
        attack_vector: NOT_APPLICABLE,
        timing: NOT_APPLICABLE,
    },
};

export function riskFor(tier: Tier): Partial<Risk> {
    const shape = SHAPES[tier];
    const landed = tierOf(score(shape));

    if (landed !== tier) {
        throw new Error(`riskFor('${tier}') scores ${score(shape)}, which is '${landed}'. Retune SHAPES or the weights.`);
    }

    return shape;
}

/** Every axis answered `not-applicable`, for a case about a finding that rated nothing. */
export const NO_RISK: Partial<Risk> = Object.fromEntries(AXIS_NAMES.map((axis) => [axis, NOT_APPLICABLE]));

/** A valid finding, for the code that reads one. */
export function finding(over: Partial<Finding> = {}): Finding {
    return {
        file: "a.ts",
        line: 1,
        risk: riskFor("low"),
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
        risk: riskFor("high"),
        category: "correctness",
        title: "A title",
        body: "A body.",
        status: "new",
        ...over,
    };
}
