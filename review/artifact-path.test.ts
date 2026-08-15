import { describe, expect, test } from "bun:test";
import { ArtifactPathRefused, resolveArtifactPath } from "./artifact-path.ts";

const BUILD = "/tmp/codeferret/build";

const resolve = (input: string) => resolveArtifactPath(input, BUILD);

describe("resolveArtifactPath: what upload-artifact is given", () => {
    test("the shipped default keeps the findings file and nothing else", () => {
        expect(resolve("findings.json")).toEqual({ paths: [`${BUILD}/findings.json`], keepsFindings: true });
    });

    test("a bare dot is the whole build directory, which also keeps the findings", () => {
        expect(resolve(".")).toEqual({ paths: [BUILD], keepsFindings: true });
        expect(resolve("./")).toEqual({ paths: [BUILD], keepsFindings: true });
        expect(resolve(".//")).toEqual({ paths: [BUILD], keepsFindings: true });
    });

    // The defect `normalise` exists for: read as keeping the findings while producing a path
    // upload-artifact refuses, so the review linked an artifact nothing had uploaded and left
    // every finding below high out of the body. `.//` and a trailing slash got past the first
    // version of it, which stripped one leading `./` and nothing else.
    test("every spelling of one file names it and answers alike", () => {
        for (const spelling of ["./findings.json", ".//findings.json", "findings.json/", ".//findings.json//"]) {
            expect(resolve(spelling)).toEqual(resolve("findings.json"));
        }
    });

    test("anything else keeps no findings, so the body carries them itself", () => {
        expect(resolve("run.json")).toEqual({ paths: [`${BUILD}/run.json`], keepsFindings: false });
        expect(resolve("reports/one.sarif")).toEqual({ paths: [`${BUILD}/reports/one.sarif`], keepsFindings: false });
    });

    test("a leading `./` comes off a nested path too", () => {
        expect(resolve("./reports/one.sarif").paths).toEqual([`${BUILD}/reports/one.sarif`]);
    });
});

describe("resolveArtifactPath: a list of paths", () => {
    // What this repository's own workflow keeps: what a maintainer reads when a review goes
    // wrong, and not existing.json or previous.json, which carry other people's words.
    const NARROW = "findings.json\nrun.json\nlens-list.txt";

    test("names each file, and keeps the findings because one of them is the findings", () => {
        expect(resolve(NARROW)).toEqual({
            paths: [`${BUILD}/findings.json`, `${BUILD}/run.json`, `${BUILD}/lens-list.txt`],
            keepsFindings: true,
        });
    });

    test("a list without the findings file answers false, so the body carries them", () => {
        expect(resolve("run.json\nlens-list.txt").keepsFindings).toBe(false);
    });

    // A workflow author writes a list as a YAML block scalar, which leaves the indentation on
    // and a trailing newline behind. A single path written that way is still a single path,
    // and it used to be refused with a message that named neither the newline nor the scalar.
    test("a block scalar's indentation and trailing newline are formatting", () => {
        expect(resolve("    findings.json\n")).toEqual(resolve("findings.json"));
        expect(resolve("  findings.json\n\n  run.json\n")).toEqual(resolve("findings.json\nrun.json"));
    });

    test("two spellings of one file go up once", () => {
        expect(resolve("findings.json\n./findings.json").paths).toEqual([`${BUILD}/findings.json`]);
    });
});

describe("resolveArtifactPath: what it refuses", () => {
    for (const input of ["..", "../x", "a/../b", "a/..", "findings.json\n../x"]) {
        test(`'${input}' escapes the build directory`, () => {
            expect(() => resolve(input)).toThrow(ArtifactPathRefused);
        });
    }

    for (const input of ["a/./b", "a/."]) {
        test(`'${input}' carries a '.' segment upload-artifact refuses`, () => {
            expect(() => resolve(input)).toThrow(ArtifactPathRefused);
        });
    }

    // Not a refusal. A leading run of `./` is a spelling of the path after it, and
    // `normalise` is what makes the two answers agree.
    test("'././a' names 'a'", () => {
        expect(resolve("././a")).toEqual(resolve("a"));
    });

    test("'.' among other paths is already all of them, and the refusal says so", () => {
        expect(() => resolve("findings.json\n.")).toThrow(ArtifactPathRefused);
    });

    test("a value holding no path at all is refused rather than read as uploading nothing", () => {
        expect(() => resolve("")).toThrow(ArtifactPathRefused);
        expect(() => resolve("\n   \n")).toThrow(ArtifactPathRefused);
    });

    test("a dot inside a name escapes nothing and is kept", () => {
        expect(resolve("tool-report..json").paths).toEqual([`${BUILD}/tool-report..json`]);
    });

    for (const input of ["/findings.json", "//findings.json", "/etc/passwd", "findings.json\n/run.json"]) {
        test(`'${input}' is absolute, and everything here resolves against the build directory`, () => {
            expect(() => resolve(input)).toThrow(ArtifactPathRefused);
        });
    }

    for (const input of ["*", "**", "?indings.json", "sub/*.json", "[abc].json", "a{b,c}.json", "!run.json"]) {
        test(`'${input}' is a pattern rather than a name`, () => {
            expect(() => resolve(input)).toThrow(ArtifactPathRefused);
        });
    }
});
