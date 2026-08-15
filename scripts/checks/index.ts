/**
 * Every check, in the order the suite runs them.
 *
 * The one place the suite is visible. A check lives in `scripts/checks/<name>.ts`, named for
 * the key it is listed under here, so a failing line names a file a reader can open without
 * coming back through this one. What that leaves this file to hold is the order and the
 * names, and a check missing from it is a check that never runs.
 *
 * The order is not arbitrary. The cheap manifest reads come first, so a broken action.yml is
 * reported before the checks that spawn a generator or shell out to shellcheck spend a second
 * each finding out the same thing.
 */

import { checkAction } from "./action.ts";
import { checkActionShell } from "./action-shell.ts";
import { checkBunConfig } from "./bun-config.ts";
import { checkBundledSkills } from "./skills.ts";
import { checkDefaults } from "./defaults.ts";
import { checkFindingRules } from "./finding-rules.ts";
import { checkGenerated } from "./generated.ts";
import { checkMarketplace } from "./marketplace.ts";
import { checkPluginManifest } from "./plugin.ts";
import { checkPrompts } from "./prompts.ts";
import { checkProvenance } from "./provenance.ts";
import { checkRunFiles } from "./run-files.ts";
import { checkShippedVersions } from "./versions.ts";
import { checkSkillFences } from "./skill-fences.ts";
import { checkStandingDetail } from "./standing-detail.ts";
import { checkToolchainPin } from "./toolchain.ts";
import { checkWorkflowLenses } from "./workflow-lenses.ts";
import { checkWorkflows } from "./workflows.ts";
import type { Failures } from "./support.ts";

export type Check = [name: string, run: () => Promise<Failures>];

export const CHECKS: Check[] = [
    ["action", checkAction],
    ["action-shell", checkActionShell],
    ["plugin", checkPluginManifest],
    ["marketplace", checkMarketplace],
    ["skills", checkBundledSkills],
    ["skill-fences", checkSkillFences],
    ["provenance", checkProvenance],
    ["defaults", checkDefaults],
    ["workflow-lenses", checkWorkflowLenses],
    ["generated", checkGenerated],
    ["finding-rules", checkFindingRules],
    ["run-files", checkRunFiles],
    ["bun-config", checkBunConfig],
    ["toolchain", checkToolchainPin],
    ["standing-detail", checkStandingDetail],
    ["prompts", checkPrompts],
    ["workflows", checkWorkflows],
    ["versions", checkShippedVersions],
];
