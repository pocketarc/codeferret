/**
 * What a finding's risk is made of, and the arithmetic that turns it into one number.
 *
 * The severity this replaces was six words with no definition anywhere: `merged-schema.json`
 * gave the enum no `description` while every sibling field had prose, and the lens brief said
 * only that severity had a field of its own. review/DECISIONS.md refused to filter on it for
 * exactly that reason, and was right to — a label too unreliable to show is too unreliable to
 * hide findings with. What changes here is the instrument, not the appetite for filtering: a
 * model answers bounded questions it can actually judge from a diff, and the weighing happens
 * in this file, where it is a pure function over an object and a test can pin it. "A finding
 * shows the claim and nothing else" in review/DECISIONS.md has the argument.
 *
 * `AXES` is the one home for all of it: the enum a model may answer with, the prose it reads
 * to choose, and the number each answer is worth. `scripts/build-risk-schema.ts` renders the
 * schema fragment from this table, so the values a model is offered cannot drift from the
 * values this file scores. Adding an axis here and forgetting the schema is a failing check
 * rather than an axis nothing fills in.
 *
 * The kinds of axis do not combine the same way, and `kind` is where the table records which
 * way each one combines.
 *
 * `weighted` axes say how bad the thing is. They are a sum over the whole set, so an axis
 * that says nothing contributes nothing. Sharing its weight among the axes that did answer
 * was the first version, and it paid a finding for the questions it could not answer: a stale
 * comment answering two axes scored what a missing index answering six did.
 *
 * `reach`, `exposure` and `certainty` say how much the badness counts. They multiply, because a
 * defect nobody can reach and a defect nobody is sure is real are both worth less than their
 * consequences suggest, in proportion rather than by a fixed subtraction. Added instead, a
 * speculative catastrophe outranks a confirmed moderate defect, which is the failure mode this
 * whole file exists to avoid.
 *
 * A `cost` axis says what the defect costs to live with when nothing ever goes wrong at run
 * time. It is scored on a scale of its own, bounded by `COST_CEILING`, and the score is the
 * greater of the two: a finding qualifies on danger or on cost, whichever is worse. The
 * comment in `score` has the measurement that separated them.
 */

/** A value a model may answer with, the prose it reads to choose it, and what it is worth. */
export interface Level {
    readonly value: string;
    readonly meaning: string;
    /** 0 to 1. For a weighted axis, its share of the axis; for any other, its factor. */
    readonly score: number;
}

/**
 * How an axis reaches the score.
 *
 * - `weighted`: a term in the sum of how bad the defect is.
 * - `cost`: what it costs to live with, on the separate scale `COST_CEILING` bounds.
 * - `reach`: a reading of who can get at it. These are averaged with each other into one term,
 *   because asking the same question from either end and multiplying both answers damps a
 *   network-facing anonymous defect twice for one fact.
 * - `exposure`: one term each in the same mean as the averaged `reach` term.
 * - `certainty`: whether there is a defect at all, so it multiplies the finished number instead
 *   of sitting in that mean. Doubt about the defect is not a reading of how exposed it is, and a
 *   finding nobody has confirmed should be damped by the whole of that doubt rather than a share.
 */
export type AxisKind = "weighted" | "cost" | "reach" | "exposure" | "certainty";

/** The kinds that multiply rather than add, for a caller that has to treat them as one set. */
export const SCALING_KINDS = ["reach", "exposure", "certainty"] as const satisfies readonly AxisKind[];

interface Weighted {
    readonly kind: "weighted";
    /** What the model is asked. Rendered into the schema as the field's description. */
    readonly question: string;
    /** Share of the total. */
    readonly weight: number;
    readonly levels: readonly Level[];
}

interface Unweighted {
    readonly kind: Exclude<AxisKind, "weighted">;
    readonly question: string;
    readonly levels: readonly Level[];
}

export type Axis = Weighted | Unweighted;

/**
 * `not-applicable` is spelled the same on every axis so a reader of a findings file can grep
 * for it, and so the two kinds can share one test for "this axis said nothing".
 */
export const NOT_APPLICABLE = "not-applicable";

/** The least the reach axes may multiply a score by. `score` has why. */
const REACH_FLOOR = 0.4;

/**
 * The most a finding can score on maintenance cost alone.
 *
 * A judgement rather than a measurement, and the one worth arguing with: no amount of debt is
 * a `critical`, because `critical` is what a person is asked to stop for. The worst thing a
 * duplicated invariant does is cost the next editor an afternoon, and the worst thing an
 * unauthenticated injection does is not that. Set here so the ceiling is one number a reader
 * can find rather than an emergent property of the weights.
 *
 * The value puts the worst answer in the middle of `medium`: high enough that a rule with no
 * check behind it is printed, low enough that it does not outrank a hazard. At 0.42 it did:
 * every `compounding` finding of a real review scored an identical 42 and the whole band sat
 * above a defect letting a lens dictate the posted comment.
 */
const COST_CEILING = 0.35;

const NA = (meaning: string): Level => ({ value: NOT_APPLICABLE, meaning, score: 0 });

export const AXES = {
    impact: {
        kind: "weighted",
        weight: 0.28,
        question: "The worst outcome that could realistically follow if this defect is left in.",
        levels: [
            { value: "catastrophic", meaning: "Arbitrary code execution, total data loss, or funds moved wrongly.", score: 1 },
            { value: "serious", meaning: "Data disclosed or corrupted, authentication bypassed, or a feature broken for everyone.", score: 0.7 },
            { value: "moderate", meaning: "A feature works incorrectly in a way a user would notice and report.", score: 0.4 },
            { value: "minor", meaning: "Cosmetic, or wrong only in an edge case nobody depends on.", score: 0.15 },
            { value: "none", meaning: "Nothing goes wrong. A style or clarity point.", score: 0 },
        ],
    },

    data_exposure: {
        kind: "weighted",
        weight: 0.18,
        question: "What data this puts at risk, and whether losing it would be reportable.",
        levels: [
            { value: "regulated", meaning: "Health, payment card, or personal data whose breach is reportable under GDPR, PCI DSS or HIPAA.", score: 1 },
            { value: "credentials", meaning: "Tokens, keys, passwords or session material.", score: 0.9 },
            { value: "personal", meaning: "Data identifying a person, without a specific reporting duty attached.", score: 0.6 },
            { value: "internal", meaning: "Business data that is not public and not about a person.", score: 0.3 },
            { value: "none", meaning: "No data is exposed.", score: 0 },
        ],
    },

    blast_radius: {
        kind: "weighted",
        weight: 0.16,
        question: "How much is affected when this goes wrong, rather than how badly.",
        levels: [
            { value: "system", meaning: "Everything: every account's data, or the machine the service runs on.", score: 1 },
            { value: "all-users", meaning: "Every user's data, where the service itself keeps running.", score: 0.75 },
            { value: "tenant", meaning: "One organisation's data where others are untouched. Only where the application separates them; an application with no such separation has no answer between this and every user's data.", score: 0.5 },
            { value: "single-user", meaning: "Only the person who triggers it, their own data included.", score: 0.2 },
            { value: "none", meaning: "Nothing is affected at run time.", score: 0 },
        ],
    },

    reversibility: {
        kind: "weighted",
        weight: 0.13,
        question: "Whether the damage can be undone once it has happened.",
        levels: [
            { value: "irreversible", meaning: "Deleted data with no backup, a leaked secret, or a settled payment.", score: 1 },
            { value: "costly", meaning: "Recoverable, but only by hand, from backups, or with a migration.", score: 0.6 },
            { value: "reversible", meaning: "Undone by fixing the code and re-running.", score: 0.2 },
            NA("Nothing happens that would need undoing."),
        ],
    },

    detectability: {
        kind: "weighted",
        weight: 0.09,
        question: "Whether anyone would find out this had happened.",
        levels: [
            { value: "silent", meaning: "No error, no log, no alert. Wrong numbers or missing records that look correct.", score: 1 },
            { value: "delayed", meaning: "Discovered eventually, by reconciliation, a report, or a user complaint.", score: 0.55 },
            { value: "obvious", meaning: "Fails loudly: an exception, a failed request, a broken page.", score: 0.15 },
            NA("Nothing happens at run time to detect."),
        ],
    },

    availability: {
        kind: "weighted",
        weight: 0.08,
        question: "What this costs in liveness or resources.",
        levels: [
            { value: "outage", meaning: "Can take the service down: unbounded query, exhaustion, deadlock, no timeout.", score: 1 },
            { value: "degradation", meaning: "Measurably slower or heavier under ordinary load.", score: 0.5 },
            { value: "none", meaning: "No effect on liveness.", score: 0 },
            NA("Not code that runs under load."),
        ],
    },

    contract: {
        kind: "weighted",
        weight: 0.08,
        question: "Whether this breaks a rule that is written down somewhere, rather than one you are applying. A change that does not do what it was asked to do is the strongest form of this short of an external standard.",
        levels: [
            { value: "standard", meaning: "Violates a named external standard: a WCAG criterion, an RFC, a documented API contract.", score: 1 },
            { value: "requirement", meaning: "Does not do what this change was asked to do. The issue or the spec states it and the code does otherwise.", score: 0.8 },
            { value: "house-rule", meaning: "Violates a convention this repository has written down for itself.", score: 0.6 },
            { value: "none", meaning: "No written rule covers it. The claim rests on your judgement.", score: 0 },
        ],
    },

    maintenance: {
        kind: "cost",
        question:
            "What this costs to live with, if nothing ever goes wrong at run time. This is the " +
            "axis for a defect that is expensive rather than dangerous.",
        levels: [
            { value: "compounding", meaning: "Gets worse on its own: a rule with no check behind it, an invariant stated in prose that the next edit will break silently.", score: 1 },
            { value: "duplicated", meaning: "The same fact or logic in more than one place, with nothing keeping the copies in step.", score: 0.7 },
            { value: "untested", meaning: "Logic with no test, where a wrong change would pass every gate.", score: 0.55 },
            { value: "friction", meaning: "Costs a reader or an editor time: misleading naming, a stale comment, a hard-to-follow structure.", score: 0.3 },
            { value: "none", meaning: "No ongoing cost. Fixing it is the whole of the work.", score: 0 },
            NA("A hazard rather than a cost, so what it would cost to live with is not the question."),
        ],
    },

    likelihood: {
        kind: "exposure",
        question: "How likely the bad outcome is to be reached in practice, not how bad it would be.",
        levels: [
            { value: "certain", meaning: "Happens every time the code runs.", score: 1 },
            { value: "likely", meaning: "Happens under ordinary use, without anyone trying.", score: 0.85 },
            { value: "possible", meaning: "Needs an unusual input, a specific sequence, or deliberate effort.", score: 0.6 },
            { value: "unlikely", meaning: "Needs a race, a rare configuration, or several things to go wrong at once.", score: 0.35 },
            { value: "theoretical", meaning: "No path you can actually construct, though the shape is wrong.", score: 0.15 },
            NA("Nothing goes wrong at run time, so there is no outcome to be likely. A maintenance cost rather than a hazard."),
        ],
    },

    confidence: {
        kind: "certainty",
        question: "How sure you are the defect is real, having read the code rather than recognised a pattern.",
        levels: [
            { value: "confirmed", meaning: "Traced in the code. You can name the path from input to damage.", score: 1 },
            { value: "probable", meaning: "Strongly implied by what you read, without following every branch.", score: 0.8 },
            { value: "possible", meaning: "Consistent with the code, but it depends on something you could not see.", score: 0.5 },
            { value: "speculative", meaning: "A recognised shape. You have not confirmed it does what you suspect.", score: 0.25 },
        ],
    },

    privileges_required: {
        kind: "reach",
        question: "What someone must already have in order to trigger this.",
        levels: [
            { value: "none", meaning: "Anonymous. No account, no session.", score: 1 },
            { value: "user", meaning: "Any ordinary authenticated account.", score: 0.8 },
            { value: "elevated", meaning: "An administrator, or a role granted deliberately.", score: 0.45 },
            { value: "maintainer", meaning: "Someone who can already deploy or push code, so could do the damage anyway.", score: 0.2 },
            NA("Not something anyone triggers."),
        ],
    },

    attack_vector: {
        kind: "reach",
        question: "Where this can be reached from. Not every defect is attacked; one an ordinary user walks into has its own answer.",
        levels: [
            { value: "network", meaning: "Over the internet, by anyone who can reach the service.", score: 1 },
            { value: "ordinary-use", meaning: "By any user going about normal use, with nobody attacking. An accessibility or correctness defect everyone hits.", score: 0.9 },
            { value: "local", meaning: "Only from the machine, or from inside the network boundary.", score: 0.5 },
            { value: "ci", meaning: "Only through the build or deployment pipeline.", score: 0.4 },
            { value: "push-access", meaning: "Only by someone who can already commit to this repository.", score: 0.25 },
            NA("Not reachable by anybody. A correctness or clarity defect."),
        ],
    },

    timing: {
        kind: "exposure",
        question: "Whether this is exploitable now or only under conditions that do not hold yet.",
        levels: [
            { value: "live", meaning: "Exploitable against the code as it stands.", score: 1 },
            { value: "latent", meaning: "Needs a future caller, a config change, or more data than exists today.", score: 0.5 },
            NA("Not a question of timing."),
        ],
    },
} as const satisfies Record<string, Axis>;

export type AxisName = keyof typeof AXES;

/** Every axis, as a model answers it. One string per axis, all required. */
export type Risk = Record<AxisName, string>;

export const AXIS_NAMES = Object.keys(AXES) as AxisName[];

function levelsOf(axis: AxisName): readonly Level[] {
    return AXES[axis].levels;
}

export function axesOf(kind: AxisKind): AxisName[] {
    return AXIS_NAMES.filter((axis) => AXES[axis].kind === kind);
}

/**
 * What one answer is worth, or null where the axis said nothing.
 *
 * An answer the table does not carry is null rather than zero. A model writing `severe` where
 * the enum says `serious` has answered nothing, and treating that as the bottom of the scale
 * would score a catastrophe as harmless on the strength of a typo. Only the orchestrator's
 * output is schema-validated, so this is reachable.
 */
export function levelScore(axis: AxisName, value: string): number | null {
    if (value === NOT_APPLICABLE) return null;

    return levelsOf(axis).find((level) => level.value === value)?.score ?? null;
}

/**
 * The axes this risk did not answer: absent, or carrying a value the table does not know.
 *
 * `not-applicable` is not among them. That is an answer, and a deliberate one.
 *
 * The distinction matters because a score cannot express it. An axis nobody answered
 * contributes nothing, which is arithmetically identical to an axis answered at its mildest,
 * so `impact: catastophic` scores what `impact: none` scores: measured, one typo took a
 * finding from 62 to 36, a whole tier. Nothing downstream could tell that from a finding
 * somebody had rated as harmless, and a finding with no `risk` object at all scored 0, banded
 * to `nit`, and left the comment with no sentence anywhere saying why.
 *
 * So the failure is reported rather than folded into the number. `isPrinted` prints an unrated
 * finding whatever its tier, on the same reasoning the severity this replaced carried about a
 * label nothing recognised: refusing to print a defect because the rating went wrong is the
 * wrong way to be wrong.
 */
export function unratedAxes(risk: Partial<Risk> | undefined): AxisName[] {
    if (!risk) return [...AXIS_NAMES];

    return AXIS_NAMES.filter((axis) => {
        const value = risk[axis];

        return value === undefined || (value !== NOT_APPLICABLE && levelScore(axis, value) === null);
    });
}

/**
 * A finding's risk, 0 to 100.
 *
 * The weighted axes are a sum over the whole set, so an axis that says nothing adds nothing. The
 * rest multiply it, each according to its `kind`, which `AxisKind` lays out.
 */
export function score(risk: Partial<Risk>): number {
    let base = 0;

    for (const axis of AXIS_NAMES) {
        const spec = AXES[axis];

        if (spec.kind !== "weighted") continue;

        // The weights of the whole set are the denominator, so an axis that says nothing
        // contributes nothing. Sharing its weight out among the axes that did answer was the
        // first version and it inflated exactly the findings it should not have: a stale
        // comment answers two axes and scored what a missing index answering six did.
        base += (levelScore(axis, risk[axis] ?? NOT_APPLICABLE) ?? 0) * spec.weight;
    }

    // Floored, so being hard to reach demotes a finding without deleting it. Unfloored, a
    // hardcoded credential rated `push-access` on both reach axes went from a base of 0.82 to
    // a score of 20, and that rating is the one a model reaches for about anything sitting in
    // source.
    const reach = Math.max(mean(axesOf("reach"), risk), REACH_FLOOR);

    // The reachability answers combine as a geometric mean rather than a product. Multiplied,
    // they compound at a rate nothing justifies: measured over a real review, a finding letting
    // a lens dictate the whole posted comment had a base of 0.53 and two middling answers,
    // `likelihood: possible` and `attack_vector: ci`, and the two alone cut it to 19, below a
    // wrong sentence in an input description. They are readings of one question, how exposed
    // this is, so the mean of them is the answer and the product is a separate discount for
    // each.
    const exposure = geometricMean([reach, ...axesOf("exposure").map((axis) => scaling(axis, risk))]);

    const confidence = axesOf("certainty").reduce((factor, axis) => factor * scaling(axis, risk), 1);

    // What it would cost to live with, on a scale of its own rather than as one more term in
    // the sum above. Summed, the two dimensions diluted each other: a finding that is purely
    // dangerous can only answer the cost axis `none`, so it forfeits that axis's weight, and
    // measured over a real review the defect letting a lens dictate the whole posted comment
    // fell below four findings about a check that had stopped binding. A finding earns its
    // place by being dangerous or by being expensive, so the two are compared rather than
    // added.
    //
    // Cost is not multiplied by `exposure`. A duplicated invariant costs the same to live with
    // whether or not anyone can reach it over a network. It is multiplied by `confidence`,
    // because a cost nobody has confirmed is worth no more than a hazard nobody has confirmed.
    const cost = costOf(risk) * COST_CEILING;

    return Math.round(100 * confidence * Math.max(base * exposure, cost));
}

/**
 * What one answer on a multiplying axis is worth, or null where there is nothing to score.
 *
 * A value the table does not carry is worth the mildest answer on the axis, for the same reason
 * a weighted axis nobody answered is worth nothing. Falling through to the most generous
 * multiplier gave a misspelt `confirmed` the score of `confirmed`: measured on the fixture's
 * path traversal, rated `confirmed` and scoring 44, `speculative` scores it 11 and the typo used
 * to score it 44.
 *
 * Damping a finding that way loses nothing, because `unratedAxes` reports an unreadable answer
 * and an absent one alike and `isPrinted` prints the finding whatever its tier. What the mildest
 * answer settles is where it sorts, and what a reader re-scoring `risk` out of `findings.json`
 * computes.
 */
function factorOf(axis: AxisName, risk: Partial<Risk>): number | null {
    const said = risk[axis];
    const answered = said === undefined ? null : levelScore(axis, said);

    if (answered !== null) return answered;

    const levels = levelsOf(axis);

    // `not-applicable` scores 0 wherever it appears, so leaving it in would make a typo worth
    // less than any answer the model could have given.
    const mildest = Math.min(...levels.filter((level) => level.value !== NOT_APPLICABLE).map((level) => level.score));

    if (said !== undefined && said !== NOT_APPLICABLE) return mildest;

    return levels.some((level) => level.value === NOT_APPLICABLE) ? null : mildest;
}

function scaling(axis: AxisName, risk: Partial<Risk>): number {
    return factorOf(axis, risk) ?? 1;
}

function geometricMean(factors: number[]): number {
    if (factors.length === 0) return 1;

    return factors.reduce((product, factor) => product * factor, 1) ** (1 / factors.length);
}

/** The worst thing this finding costs to live with, 0 to 1. */
function costOf(risk: Partial<Risk>): number {
    const scored = axesOf("cost").map((axis) => levelScore(axis, risk[axis] ?? NOT_APPLICABLE) ?? 0);

    return Math.max(0, ...scored);
}

/** The mean of the axes that answered, or 1 where none did, so silence does not damp anything. */
function mean(axes: readonly AxisName[], risk: Partial<Risk>): number {
    const answered = axes.map((axis) => factorOf(axis, risk)).filter((value): value is number => value !== null);

    if (answered.length === 0) return 1;

    return answered.reduce((total, value) => total + value, 0) / answered.length;
}

/**
 * The bands, highest first. A tier is what the threshold compares against and what the review
 * body says, because a reader ranks "high" faster than they rank 61.
 *
 * The cuts have a measurement behind them. `REVIEW_THRESHOLD` in read-run.ts records a blind
 * rating of the fixture branch against these bands: six seeded defects between 79 and 36, three
 * decoys at 11. `COST_CEILING` above was placed against these same bands, on a real review
 * rather than on the fixture. Move a cut and both readings mean something else; `riskFor` in
 * test-fixtures.ts fails the moment a shape stops landing in the tier it is named for.
 *
 * The band edges are unmeasured. The rating landed the path traversal on 44, a point under
 * `high`, and says nothing about which side of that line it should have been on. Nothing here
 * has been scored against a repository unlike the fixture either.
 */
export const TIERS = [
    { tier: "critical", atLeast: 70 },
    { tier: "high", atLeast: 45 },
    { tier: "medium", atLeast: 25 },
    { tier: "low", atLeast: 10 },
    { tier: "nit", atLeast: 0 },
] as const;

export type Tier = (typeof TIERS)[number]["tier"];

export const TIER_NAMES: readonly Tier[] = TIERS.map((band) => band.tier);

export function tierOf(value: number): Tier {
    return TIERS.find((band) => value >= band.atLeast)?.tier ?? "nit";
}

/** Whether a string is one of the tiers, as a guard so a caller needs no cast to find out. */
export function isTier(value: string): value is Tier {
    return TIER_NAMES.some((name) => name === value);
}

/** Where a tier sits, for ordering and for comparing against a threshold. Lower is worse. */
export function tierRank(tier: string): number {
    const i = TIER_NAMES.indexOf(tier as Tier);

    return i === -1 ? TIER_NAMES.length : i;
}

/**
 * Whether a finding at this tier clears the threshold.
 *
 * A tier nothing recognises clears nothing, because `tierRank` ranks it below every real one.
 * That is the opposite of what `isListed` used to do with an unrecognised severity, and it is
 * right here for the reason it was right there: a severity was a label a model chose, and
 * refusing to print one nobody recognised would have hidden a defect on a spelling. A tier is
 * computed from answers this file scores, so the only way to reach an unknown one is for that
 * computation to have gone wrong, and a run whose scoring is broken should not be quietly
 * promoting findings into the review.
 */
export function meetsThreshold(tier: string, threshold: Tier): boolean {
    return tierRank(tier) <= tierRank(threshold);
}
