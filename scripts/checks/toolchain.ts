/**
 * That the two places bun is installed both take the version out of review/versions.sh.
 *
 * Both pin it because both would otherwise run a fork's code under an unpinned global
 * install. It used to be pinned twice with a comment asking for one edit, which this file
 * reconciled; one home needs no reconciling, and what is worth guarding instead is the way
 * back to two. That way is a literal typed into either caller, and the cost of it is quiet:
 * the tests pass under one bun and the review runs under another.
 *
 * Matching no literal is the passing case here, so this check has no empty-match hole. What
 * carries the weight is the positive half above it, which fails on a caller that stopped
 * reading the file.
 */

import { fail } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkToolchainPin(): Promise<Failures> {
    const list: Failures = [];
    const home = "review/versions.sh";
    const declared = (await Bun.file(home).text()).match(/^export BUN_VERSION=(\S+)$/m)?.[1];

    if (!declared) {
        fail(list, home, "declares no BUN_VERSION, so nothing pins the bun a review runs on");
        return list;
    }

    for (const file of ["action.yml", ".github/workflows/lint.yml"]) {
        const text = await Bun.file(file).text();

        if (!text.includes(home)) {
            fail(list, file, `installs bun without reading ${home}, so its version can drift again`);
            continue;
        }

        for (const [, pinned] of text.matchAll(/\bbun@([^"'\s]+)/g)) {
            if (!String(pinned).startsWith("$")) {
                fail(list, file, `pins bun@${pinned} of its own, and ${home} is where that lives`);
            }
        }
    }

    if (list.length === 0) console.log(`OK toolchain: both installs read bun@${declared} from ${home}`);

    return list;
}
