/** That every bundled lens has a row saying where it came from, and no row outlives its lens. */

import { existsSync } from "node:fs";
import { bundledLenses, fail } from "./support.ts";
import type { Failures } from "./support.ts";

export async function checkProvenance(): Promise<Failures> {
    const list: Failures = [];
    const file = "lenses/skills/PROVENANCE.tsv";

    if (!existsSync(file)) {
        fail(list, file, "is missing, so nothing records where the bundled lenses came from");
        return list;
    }

    const recorded = new Set(
        (await Bun.file(file).text())
            .split("\n")
            .slice(1)
            .map((line) => (line.split("\t")[0] ?? "").trim())
            .filter(Boolean),
    );

    const bundled = bundledLenses();

    for (const lens of bundled) {
        if (!recorded.has(lens)) fail(list, file, `has no row for bundled lens '${lens}'`);
    }

    for (const lens of recorded) {
        if (!bundled.has(lens)) fail(list, file, `records '${lens}', which is not bundled`);
    }

    if (list.length === 0) {
        console.log(`OK ${file}: ${recorded.size} row(s), one per bundled lens`);
    }
    return list;
}
