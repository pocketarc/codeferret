/**
 * That the value guards written twice, once in shell and once in TypeScript, still accept the
 * same characters.
 *
 * A sample, not a proof: both classes are read as JavaScript regexes over ALPHABET, so a
 * rewrite of either side into `\p{...}` or a POSIX class can agree here and diverge elsewhere.
 */

import { fail } from "./support.ts";
import type { Failures } from "./support.ts";

const SHELL = "review/lib.sh";
const SELECTING = "review/select-lenses.ts";

const ALPHABET = [
    ...Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCodePoint(0x20 + i)),
    "\t",
    "\n",
    "\r",
    "é",
    " ",
];

interface Pair {
    shell: string;
    file: string;
    /** What finds the copy in that file, with the character class as its one capture group. */
    literal: RegExp;
}

const PAIRS: Pair[] = [
    {
        shell: "plain_number",
        file: "review/github.ts",
        literal: /export function requirePullNumber[\s\S]*?\/\^\[([^\]]+)\]\+\$\//,
    },
    {
        shell: "plain_name",
        file: SELECTING,
        literal: /^const PLAIN_NAME = \/\^\[([^\]]+)\]\+\$\/;$/m,
    },
];

/** One `plain_*` function's body. Reads to the first `}` at column 0, so it takes lib.sh keeping every guard body indented. */
function shellBody(text: string, fn: string): string | null {
    return text.match(new RegExp(`^${fn}\\(\\) \\{$([\\s\\S]*?)^\\}$`, "m"))?.[1] ?? null;
}

/**
 * The characters that function allows.
 *
 * The `case` pattern is `"" | *[!<class>]*`, which refuses any value holding a character the
 * class does not name, so the class itself is the allowed set and reads the same way round as
 * the TypeScript one.
 */
function shellClass(text: string, fn: string): string | null {
    return shellBody(text, fn)?.match(/\*\[!([^\]]+)\]\*/)?.[1] ?? null;
}

function matcher(list: Failures, file: string, where: string, klass: string): RegExp | null {
    try {
        return new RegExp(`^[${klass}]$`, "u");
    } catch {
        fail(list, file, `${where} names \`${klass}\`, which is not a character class anything can read`);
        return null;
    }
}

export async function checkValueGuards(): Promise<Failures> {
    const list: Failures = [];
    const shell = await Bun.file(SHELL).text();

    for (const pair of PAIRS) {
        const allowed = shellClass(shell, pair.shell);

        if (!allowed) {
            fail(list, SHELL, `has no \`${pair.shell}\` with a \`case\` pattern naming what it allows`);
            continue;
        }

        const accepted = (await Bun.file(pair.file).text()).match(pair.literal)?.[1];

        if (!accepted) {
            fail(list, pair.file, `holds no copy of \`${pair.shell}\`, and ${SHELL} still has one to agree with`);
            continue;
        }

        const here = matcher(list, SHELL, pair.shell, allowed);
        const there = matcher(list, pair.file, "its copy", accepted);

        if (!here || !there) continue;

        const apart = ALPHABET.filter((c) => here.test(c) !== there.test(c));

        if (apart.length > 0) {
            const shown = apart.map((c) => JSON.stringify(c)).join(", ");

            fail(list, pair.file, `disagrees with \`${pair.shell}\` in ${SHELL} about ${shown}`);
        }
    }

    // A character class cannot say where in a value a character sits, so the leading dot is a
    // rule of its own on each side, and takes a test of its own here.
    const naming = shellBody(shell, "plain_name");

    if (naming && !naming.includes("| .*")) {
        fail(list, SHELL, "`plain_name` no longer bars a leading dot, which its TypeScript copy still does");
    }

    if (!(await Bun.file(SELECTING).text()).includes('startsWith(".")')) {
        fail(list, SELECTING, "no longer bars a lens name with a leading dot, which `plain_name` still does");
    }

    if (list.length === 0) {
        console.log(`OK value-guards: ${PAIRS.length} guard(s) accept the same characters in both languages`);
    }

    return list;
}
