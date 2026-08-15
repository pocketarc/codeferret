/**
 * What more than one check in this directory needs: the failure protocol, the parsers, and
 * the manifests each check would otherwise read again.
 *
 * A check is an `async () => Failures`. It returns what it found rather than printing it or
 * throwing, so the CLI can run the whole suite and report every problem at once, and so a
 * check can be named on its own and run alone. A clean check prints its own OK line, which is
 * the only thing here that goes to stdout as it happens: an empty list and no line is a check
 * that read nothing, and that has to look different from a check that passed.
 *
 * The working directory is set here rather than in the CLI. Every check reads paths relative
 * to the repository root, and a module body runs before the body of whatever imported it, so
 * a `chdir` in `validate-repo.ts` would happen after these modules had been evaluated. None
 * of them touches the filesystem at evaluation time today, and nothing would say so on the
 * day one did.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { reason } from "../../review/json.ts";
import { lines } from "../../review/lines.ts";

process.chdir(join(import.meta.dir, "..", ".."));

/** What one check found, one line per problem, each naming the file it is about. */
export type Failures = string[];

export function fail(list: Failures, file: string, message: string): void {
    list.push(`${file}: ${message}`);
}

export async function parseYaml(list: Failures, file: string): Promise<unknown | null> {
    try {
        return Bun.YAML.parse(await Bun.file(file).text());
    } catch (error) {
        fail(list, file, reason(error));
        return null;
    }
}

export async function parseJson(list: Failures, file: string): Promise<unknown | null> {
    try {
        return JSON.parse(await Bun.file(file).text());
    } catch (error) {
        fail(list, file, reason(error));
        return null;
    }
}

/**
 * A markdown file's YAML frontmatter.
 *
 * Parsed rather than matched. Claude Code's frontmatter parser is lenient enough that an
 * unquoted `: ` in a description loads fine and only breaks wherever something stricter
 * reads it, with nothing said in between.
 */
export async function frontmatter(
    list: Failures,
    file: string,
): Promise<Record<string, unknown> | null> {
    const block = (await Bun.file(file).text()).match(/^---\n([\s\S]*?)\n---\n/)?.[1];

    if (block === undefined) {
        fail(list, file, "has no frontmatter");
        return null;
    }

    try {
        return (Bun.YAML.parse(block) ?? {}) as Record<string, unknown>;
    } catch (error) {
        fail(list, file, `frontmatter is not valid YAML: ${reason(error)}`);
        return null;
    }
}

/**
 * A newline-separated input's value, as lines, or a failure naming the shape it was written in.
 *
 * The boundary `lines` in review/lines.ts refuses to guess at: a check reads these keys out of
 * a parsed YAML document, where a sequence is an ordinary thing for an author to write.
 *
 * An absent key is not a fault. Every caller here reads an optional input, and "not set" is
 * what an empty list already means.
 */
export function inputLines(list: Failures, file: string, key: string, value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return lines(value);

    const shape = Array.isArray(value) ? "a list" : `a ${typeof value}`;

    fail(list, file, `writes \`${key}\` as ${shape}. An action reads it as one string, so write it as a block scalar.`);

    return [];
}

export interface Action {
    name?: string;
    description?: string;
    inputs?: Record<string, { description?: string; required?: boolean; default?: unknown }>;
    runs?: {
        using?: string;
        steps?: Array<{ name?: string; shell?: string; uses?: string; run?: string }>;
    };
}

/**
 * A manifest parsed once, however many checks ask for it.
 *
 * The `Failures` list belongs to whichever check asked first, so a parse failure is
 * reported once rather than on every check that reads the file. Every one of them returns
 * early on a null, so nothing carries on as though the file had parsed.
 */
function parsedOnce<T>(load: (list: Failures) => Promise<T | null>): (list: Failures) => Promise<T | null> {
    let held: { value: T | null } | undefined;

    return async (list) => {
        if (!held) held = { value: await load(list) };

        return held.value;
    };
}

export const action = parsedOnce<Action>(async (list) => (await parseYaml(list, "action.yml")) as Action | null);

export const MANIFEST_FILE = ".claude-plugin/plugin.json";

export interface PluginManifest {
    name?: string;
    version?: string;
    description?: string;
    skills?: string;
}

export const pluginManifest = parsedOnce<PluginManifest>(
    async (list) => (await parseJson(list, MANIFEST_FILE)) as PluginManifest | null,
);

/** The template that /codeferret:install-workflow writes, which sits outside .github/. */
export const TEMPLATE = "templates/workflow.yml";

/**
 * The lenses this repository bundles: a directory under lenses/skills holding a SKILL.md.
 *
 * Read from the tree rather than filled in as a side effect of another check, because any
 * check here can be named on its own and run alone.
 */
export function bundledLenses(): Set<string> {
    return new Set(
        readdirSync("lenses/skills", { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(`lenses/skills/${entry.name}/SKILL.md`))
            .map((entry) => entry.name),
    );
}
