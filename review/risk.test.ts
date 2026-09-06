import { describe, expect, test } from "bun:test";
import { AXES, AXIS_NAMES, NOT_APPLICABLE, SCALING_KINDS, axesOf, meetsThreshold, score, tierOf, tierRank } from "./risk.ts";
import type { AxisName, Risk } from "./risk.ts";

/** Every axis answered at its worst, which is the only way to reach the top of the scale. */
const WORST: Risk = {
    impact: "catastrophic",
    data_exposure: "regulated",
    blast_radius: "system",
    reversibility: "irreversible",
    detectability: "silent",
    availability: "outage",
    contract: "standard",
    maintenance: "compounding",
    likelihood: "certain",
    confidence: "confirmed",
    privileges_required: "none",
    attack_vector: "network",
    timing: "live",
};

/** Every axis answered at its mildest. */
const MILDEST: Risk = {
    impact: "none",
    data_exposure: "none",
    blast_radius: "none",
    reversibility: "reversible",
    detectability: "obvious",
    availability: "none",
    contract: "none",
    maintenance: "none",
    likelihood: "theoretical",
    confidence: "speculative",
    privileges_required: "maintainer",
    attack_vector: "push-access",
    timing: "latent",
};

const SILENT: Risk = Object.fromEntries(AXIS_NAMES.map((axis) => [axis, NOT_APPLICABLE])) as Risk;

/**
 * The weighted axes at their mildest with nothing damping them.
 *
 * A weighted axis has to be measured against this rather than against `MILDEST`, whose
 * scaling answers multiply out to well under a hundredth: every weighted axis moved the score
 * there, and every movement rounded to the same zero.
 */
const UNDAMPED: Risk = {
    ...MILDEST,
    likelihood: "certain",
    confidence: "confirmed",
    privileges_required: "none",
    attack_vector: "network",
    timing: "live",
};

function worse(axis: AxisName, value: string): number {
    return score({ ...UNDAMPED, [axis]: value });
}

describe("score", () => {
    test("the worst answer on every axis reaches the top band", () => {
        expect(score(WORST)).toBeGreaterThanOrEqual(95);
        expect(tierOf(score(WORST))).toBe("critical");
    });

    test("the mildest answer on every axis stays at the bottom", () => {
        expect(tierOf(score(MILDEST))).toBe("nit");
    });

    test("a finding that answers nothing scores nothing", () => {
        expect(score(SILENT)).toBe(0);
    });

    test("an empty object scores nothing rather than throwing", () => {
        expect(score({})).toBe(0);
    });

    // Each weighted axis has to be able to move the result on its own, or it is costing a
    // model's attention and buying nothing.
    describe("every weighted axis moves the score by itself", () => {
        for (const axis of AXIS_NAMES.filter((name) => AXES[name].kind === "weighted")) {
            test(axis, () => {
                const worst = AXES[axis].levels[0];

                expect(worse(axis, worst.value)).toBeGreaterThan(score(UNDAMPED));
            });
        }
    });

    describe("every scaling axis damps the score by itself", () => {
        for (const axis of SCALING_KINDS.flatMap(axesOf)) {
            test(axis, () => {
                const levels = AXES[axis].levels.filter((level) => level.value !== NOT_APPLICABLE);
                const mildest = levels[levels.length - 1];

                expect(score({ ...WORST, [axis]: mildest?.value })).toBeLessThan(score(WORST));
            });
        }
    });

    test("not-applicable on a scaling axis damps nothing", () => {
        expect(score({ ...WORST, attack_vector: NOT_APPLICABLE, privileges_required: NOT_APPLICABLE })).toBe(score(WORST));
    });

    // `factorOf` in risk.ts has why: falling through to 1 gave a misspelt `confirmed` the score
    // of `confirmed`.
    describe("a confidence this file cannot score scores as the mildest level", () => {
        const levels = AXES.confidence.levels;
        const mildest = levels[levels.length - 1]?.value;
        const asMildest = score({ ...WORST, confidence: mildest });

        test("the axis has no not-applicable level, which the rest assumes", () => {
            const values: readonly string[] = levels.map((level) => level.value);

            expect(mildest).toBeString();
            expect(values).not.toContain(NOT_APPLICABLE);
        });

        test("a value the table does not carry", () => {
            expect(score({ ...WORST, confidence: "confrmed" })).toBe(asMildest);
            expect(asMildest).toBeLessThan(score(WORST));
        });

        test("not-applicable, which no level on this axis means", () => {
            expect(score({ ...WORST, confidence: NOT_APPLICABLE })).toBe(asMildest);
        });

        test("absent altogether", () => {
            const { confidence: _answered, ...unanswered } = WORST;

            expect(score(unanswered)).toBe(asMildest);
        });
    });

    test("an unanswered timing damps nothing, because the axis has a not-applicable level", () => {
        expect(score({ ...WORST, timing: NOT_APPLICABLE })).toBe(score(WORST));
    });

    describe("a value the table does not carry is the mildest answer on every multiplying axis", () => {
        for (const axis of SCALING_KINDS.flatMap(axesOf)) {
            const levels = AXES[axis].levels.filter((level) => level.value !== NOT_APPLICABLE);
            const mildest = levels[levels.length - 1]?.value;

            test(axis, () => {
                expect(score({ ...WORST, [axis]: "nonsense" })).toBe(score({ ...WORST, [axis]: mildest }));
                expect(score({ ...WORST, [axis]: "nonsense" })).toBeLessThan(score(WORST));
            });
        }
    });

    test("a typo on both reach axes is not the anonymous network answer twice over", () => {
        const mistyped = score({ ...WORST, privileges_required: "non", attack_vector: "netwrok" });

        expect(mistyped).toBeLessThan(score(WORST));
        expect(mistyped).toBe(score({ ...WORST, privileges_required: "maintainer", attack_vector: "push-access" }));
    });

    test("not-applicable on a weighted axis costs that axis and no more", () => {
        const full = score(WORST);
        const without = score({ ...WORST, availability: NOT_APPLICABLE });

        expect(without).toBeLessThan(full);
        expect(without).toBe(full - Math.round(100 * AXES.availability.weight));
    });

    // The first version shared an unanswered axis's weight among the rest, which paid a
    // finding for the questions it could not answer: a stale comment answering two axes
    // scored what a missing index answering six did.
    test("answering fewer axes does not inflate a trivial finding", () => {
        const staleComment = score({
            ...SILENT,
            impact: "minor",
            data_exposure: "none",
            blast_radius: "none",
            contract: "house-rule",
            likelihood: "certain",
            confidence: "confirmed",
        });

        const missingIndex = score({
            impact: "moderate",
            data_exposure: "none",
            blast_radius: "all-users",
            reversibility: "reversible",
            detectability: "delayed",
            availability: "outage",
            contract: "none",
            likelihood: "likely",
            confidence: "probable",
            privileges_required: NOT_APPLICABLE,
            attack_vector: NOT_APPLICABLE,
            timing: "latent",
        });

        expect(staleComment).toBeLessThan(missingIndex);
    });

    test("a value the table does not carry scores as nothing rather than as the worst", () => {
        // Only the orchestrator's output is schema-validated, so a misspelling reaches here.
        expect(score({ ...SILENT, impact: "severe" })).toBe(0);
        expect(score({ ...WORST, impact: "severe" })).toBeLessThan(score(WORST));
    });

    describe("judgement the weights have to reproduce", () => {
        const sqli: Risk = {
            impact: "catastrophic",
            data_exposure: "regulated",
            blast_radius: "system",
            reversibility: "irreversible",
            detectability: "silent",
            availability: "none",
            contract: "standard",
            maintenance: "none",
            likelihood: "likely",
            confidence: "confirmed",
            privileges_required: "none",
            attack_vector: "network",
            timing: "live",
        };

        test("an unauthenticated injection on regulated data is critical", () => {
            expect(tierOf(score(sqli))).toBe("critical");
        });

        test("the same defect behind an admin wall is worth less", () => {
            expect(score({ ...sqli, privileges_required: "elevated" })).toBeLessThan(score(sqli));
        });

        // Additive confidence lets a speculative catastrophe outrank a confirmed moderate
        // defect. It scales for that reason.
        test("a speculative catastrophe ranks below a confirmed moderate defect", () => {
            const speculative = score({ ...sqli, confidence: "speculative" });

            const confirmedModerate = score({
                ...SILENT,
                impact: "moderate",
                data_exposure: "internal",
                blast_radius: "all-users",
                reversibility: "costly",
                detectability: "silent",
                contract: "none",
                likelihood: "certain",
                confidence: "confirmed",
            });

            expect(speculative).toBeLessThan(confirmedModerate);
        });

        // Rated `push-access` on both reach axes, which is what a model reaches for about
        // anything sitting in source, this scored 20 before the floor.
        test("a hardcoded credential survives being called push-access", () => {
            const credential: Risk = {
                impact: "serious",
                data_exposure: "credentials",
                blast_radius: "system",
                reversibility: "irreversible",
                detectability: "silent",
                availability: "none",
                contract: "standard",
                maintenance: "none",
                likelihood: "certain",
                confidence: "confirmed",
                privileges_required: "push-access",
                attack_vector: "push-access",
                timing: "live",
            };

            expect(tierRank(tierOf(score(credential)))).toBeLessThanOrEqual(tierRank("medium"));
        });
    });
});

describe("cost and hazard", () => {
    const pureCost = { ...SILENT, maintenance: "compounding", confidence: "confirmed" };

    test("a finding that is only expensive still reaches the page", () => {
        expect(tierRank(tierOf(score(pureCost)))).toBeLessThanOrEqual(tierRank("medium"));
    });

    test("no amount of debt is worth stopping for", () => {
        expect(tierRank(tierOf(score(pureCost)))).toBeGreaterThan(tierRank("high"));
    });

    // Summed into the weighted axes, a purely dangerous finding forfeited the cost axis's
    // weight for answering it honestly, and over a real review that put a defect letting a
    // lens dictate the whole posted comment below four findings about a stale check.
    test("answering the cost axis honestly does not cost a hazard anything", () => {
        const hazard = { ...WORST, maintenance: NOT_APPLICABLE };

        expect(score(hazard)).toBe(score({ ...WORST, maintenance: "compounding" }));
    });

    describe("every cost axis moves the score by itself", () => {
        const nothing = { ...SILENT, confidence: "confirmed" };

        for (const axis of AXIS_NAMES.filter((name) => AXES[name].kind === "cost")) {
            test(axis, () => {
                const worst = AXES[axis].levels[0];

                expect(score({ ...nothing, [axis]: worst?.value })).toBeGreaterThan(score(nothing));
            });
        }
    });

    test("a cost is not damped by how reachable it is", () => {
        const unreachable = { ...pureCost, attack_vector: "push-access", privileges_required: "maintainer" };

        expect(score(unreachable)).toBe(score(pureCost));
    });
});

describe("the axis table", () => {
    // `score` reads its terms out of `kind`, so an axis whose kind belongs to no group never
    // reaches the arithmetic and damps nothing, with every other test still green.
    test("every axis belongs to a group score() reads", () => {
        const grouped = [...axesOf("weighted"), ...axesOf("cost"), ...SCALING_KINDS.flatMap(axesOf)];

        expect(grouped.toSorted()).toEqual([...AXIS_NAMES].toSorted());
    });

    test("no axis is in two groups at once", () => {
        const grouped = [...axesOf("weighted"), ...axesOf("cost"), ...SCALING_KINDS.flatMap(axesOf)];

        expect(new Set(grouped).size).toBe(grouped.length);
    });

    test("the weighted axes sum to one, so a score is out of 100", () => {
        const total = axesOf("weighted").reduce((sum, axis) => {
            const spec = AXES[axis];

            return sum + (spec.kind === "weighted" ? spec.weight : 0);
        }, 0);

        expect(total).toBeCloseTo(1, 10);
    });

    test("every level scores between nothing and everything", () => {
        for (const axis of AXIS_NAMES) {
            for (const level of AXES[axis].levels) {
                expect(level.score).toBeGreaterThanOrEqual(0);
                expect(level.score).toBeLessThanOrEqual(1);
            }
        }
    });

    test("every axis names its values once", () => {
        for (const axis of AXIS_NAMES) {
            const values = AXES[axis].levels.map((level) => level.value);

            expect(new Set(values).size).toBe(values.length);
        }
    });

    test("every axis is ordered worst first, so a table reads as a scale", () => {
        for (const axis of AXIS_NAMES) {
            const scored = AXES[axis].levels.filter((level) => level.value !== NOT_APPLICABLE);

            expect(scored.map((level) => level.score)).toEqual([...scored.map((level) => level.score)].sort((a, b) => b - a));
        }
    });

    test("every level says what it means, since that prose is all a model gets", () => {
        for (const axis of AXIS_NAMES) {
            expect(AXES[axis].question.length).toBeGreaterThan(20);

            for (const level of AXES[axis].levels) {
                expect(level.meaning.length).toBeGreaterThan(10);
            }
        }
    });
});

describe("tiers", () => {
    test("a score lands in the band it falls in", () => {
        expect(tierOf(100)).toBe("critical");
        expect(tierOf(70)).toBe("critical");
        expect(tierOf(69)).toBe("high");
        expect(tierOf(45)).toBe("high");
        expect(tierOf(24)).toBe("low");
        expect(tierOf(0)).toBe("nit");
    });

    test("a threshold admits its own tier and everything above it", () => {
        expect(meetsThreshold("critical", "high")).toBe(true);
        expect(meetsThreshold("high", "high")).toBe(true);
        expect(meetsThreshold("medium", "high")).toBe(false);
        expect(meetsThreshold("nit", "nit")).toBe(true);
    });

    test("a tier nothing recognises clears nothing", () => {
        expect(meetsThreshold("blocker", "critical")).toBe(false);
    });
});
