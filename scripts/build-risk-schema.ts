#!/usr/bin/env bun
/**
 * Write the risk block of merged-schema.json out of review/risk.ts.
 *
 * The orchestrator answers these questions and this file scores the answers, so the enum a
 * model is offered and the enum the scorer recognises have to be the same list. Written from
 * the table rather than checked against it, for the reason build-defaults.ts gives: a check
 * only reports drift once somebody has written the second copy, and there is nothing to
 * reconcile when there is one copy.
 *
 * The prose matters as much as the values. `severity` shipped with an enum and no
 * `description` while every sibling field had one, and what a lens was told about it amounted
 * to "severity has a field of its own" — six words with no definition anywhere, which is why
 * nothing could be filtered on them. Each level's `meaning` in `AXES` is what a model reads to
 * choose, so it goes into the schema beside the value it explains.
 *
 * Usage: bun scripts/build-risk-schema.ts [--check]
 */

import { join } from "node:path";
import { AXES, AXIS_NAMES, NOT_APPLICABLE } from "../review/risk.ts";
import { writeOrCheck } from "./generated.ts";

process.chdir(join(import.meta.dir, ".."));

const SCHEMA = "review/merged-schema.json";

/** Marks the block this script owns, so a hand edit inside it is a failing check. */
export const RISK_KEY = "risk";

interface Property {
    type: string;
    enum?: string[];
    description?: string;
    properties?: Record<string, Property>;
    required?: string[];
    additionalProperties?: boolean;
}

/**
 * One axis as a schema property: the values, and the question with every value's meaning
 * spelled out after it.
 *
 * The meanings are in the description rather than left to the value names because a model
 * choosing between `serious` and `moderate` on the strength of the two words alone is doing
 * what the severity enum asked for, and that is the failure this replaces.
 */
function propertyFor(axis: (typeof AXIS_NAMES)[number]): Property {
    const spec = AXES[axis];
    const meanings = spec.levels.map((level) => `${level.value}: ${level.meaning}`).join(" ");

    return {
        type: "string",
        enum: spec.levels.map((level) => level.value),
        description: `${spec.question} ${meanings}`,
    };
}

export function riskSchema(): Property {
    const properties: Record<string, Property> = {};

    for (const axis of AXIS_NAMES) properties[axis] = propertyFor(axis);

    return {
        type: "object",
        required: [...AXIS_NAMES],
        additionalProperties: false,
        description:
            "How much this finding matters, as answers a diff can support rather than one overall word. " +
            `Every axis is required; answer \`${NOT_APPLICABLE}\` where the question does not apply to this ` +
            "kind of defect rather than guessing, because a guess is scored and a stated non-answer is not. " +
            "review/risk.ts turns these into a number and a tier; nothing here is a tier.",
        properties,
    };
}

const schema = JSON.parse(await Bun.file(SCHEMA).text()) as {
    properties: { findings: { items: { properties: Record<string, unknown>; required: string[] } } };
};

const item = schema.properties.findings.items;

item.properties[RISK_KEY] = riskSchema();

if (!item.required.includes(RISK_KEY)) item.required.push(RISK_KEY);

const written = await writeOrCheck(
    new Map([[SCHEMA, `${JSON.stringify(schema, null, 4)}\n`]]),
    process.argv.includes("--check"),
    "bun scripts/build-risk-schema.ts",
);

if (written.problems > 0) process.exit(1);

if (!process.argv.includes("--check")) {
    console.log(`OK ${SCHEMA}: ${AXIS_NAMES.length} risk axes written from review/risk.ts`);
}
