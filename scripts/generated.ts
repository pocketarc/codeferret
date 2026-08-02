/**
 * Write a set of generated files, or check the ones on disk against what would be written.
 *
 * Shared by both generators, because this is the shape that decides whether a hand edit to
 * a generated file is caught, and one copy of it keeps that answer the same for both.
 */

import { existsSync } from "node:fs";

export interface Written {
    /** Files whose contents on disk disagree with what the generator would write. */
    problems: number;
}

export async function writeOrCheck(
    files: Map<string, string>,
    check: boolean,
    regenerateWith: string,
): Promise<Written> {
    let problems = 0;

    for (const [path, content] of files) {
        if (!check) {
            await Bun.write(path, content);
            continue;
        }

        const current = existsSync(path) ? await Bun.file(path).text() : null;

        if (current === null) {
            console.error(`FAIL ${path} is missing`);
            problems += 1;
        } else if (current !== content) {
            console.error(`FAIL ${path} does not match its source`);
            problems += 1;
        }
    }

    if (problems > 0 && check) console.error(`\nRun \`${regenerateWith}\` to regenerate.`);

    return { problems };
}
