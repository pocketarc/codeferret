/**
 * Every workflow parses and has a job, and the shipped template's gate matches this
 * repository's own.
 *
 * The template ships the gate this repository runs on itself, and the reasoning for that
 * gate lives only in the template. Tighten it in one file and not the other, and either this
 * repository reviews pull requests it decided not to, or every consumer who installed the
 * template does.
 */

import { existsSync, readdirSync } from "node:fs";
import { fail, parseYaml, TEMPLATE } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkWorkflows(): Promise<Failures> {
    const list: Failures = [];
    const dir = ".github/workflows";

    const files = (existsSync(dir) ? readdirSync(dir) : [])
        .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
        .map((entry) => `${dir}/${entry}`);

    if (files.length === 0) fail(list, dir, "holds no workflow");

    // The template sits outside .github/, so nothing else parses it, here or on GitHub. Pushed
    // whether or not it is there: with the push guarded on its existence, a deleted template
    // took the gate comparison below out with it and said nothing, and `parseYaml` names a
    // missing file.
    files.push(TEMPLATE);

    const gates = new Map<string, string>();

    for (const file of files) {
        const workflow = (await parseYaml(list, file)) as { jobs?: Record<string, { if?: string }> } | null;
        if (!workflow) continue;

        const jobs = Object.keys(workflow.jobs ?? {});
        if (jobs.length === 0) fail(list, file, "no jobs");
        else console.log(`OK ${file}: jobs ${jobs.join(", ")}`);

        const gate = workflow.jobs?.review?.if;
        if (typeof gate === "string") gates.set(file, gate.replace(/\s+/g, " ").trim());
    }

    const own = `${dir}/codeferret.yml`;

    // Required rather than compared only when both happen to be present: a gate silently
    // missing from either file is the drift this check exists to catch, not a reason to skip
    // the comparison.
    if (!gates.has(own)) fail(list, own, "declares no jobs.review.if, so nothing gates whose code the agent runs on");
    if (!gates.has(TEMPLATE)) fail(list, TEMPLATE, "declares no jobs.review.if, so nothing gates whose code the agent runs on");

    if (gates.has(own) && gates.has(TEMPLATE) && gates.get(own) !== gates.get(TEMPLATE)) {
        fail(list, TEMPLATE, `jobs.review.if does not match ${own}`);
    }

    return list;
}
