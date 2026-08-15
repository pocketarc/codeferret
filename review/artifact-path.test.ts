import { describe, expect, test } from "bun:test";
import { ArtifactPathRefused, resolveArtifactPath } from "./artifact-path.ts";

const BUILD = "/tmp/codeferret/build";

const resolve = (input: string) => resolveArtifactPath(input, BUILD);

describe("resolveArtifactPath: what upload-artifact is given", () => {
    test("the shipped default keeps the findings file and nothing else", () => {
        expect(resolve("findings.json")).toEqual({ path: `${BUILD}/findings.json`, keepsFindings: true });
    });

    test("a bare dot is the whole build directory, which also keeps the findings", () => {
        expect(resolve(".")).toEqual({ path: BUILD, keepsFindings: true });
        expect(resolve("./")).toEqual({ path: BUILD, keepsFindings: true });
    });

    // The defect the `./` stripping exists for: read as keeping the findings while producing
    // a path upload-artifact refuses, so the review linked an artifact nothing had uploaded
    // and left every finding below high out of the body.
    test("`./findings.json` and `findings.json` name one file and answer alike", () => {
        expect(resolve("./findings.json")).toEqual(resolve("findings.json"));
    });

    test("anything else keeps no findings, so the body carries them itself", () => {
        expect(resolve("run.json")).toEqual({ path: `${BUILD}/run.json`, keepsFindings: false });
        expect(resolve("reports/one.sarif")).toEqual({ path: `${BUILD}/reports/one.sarif`, keepsFindings: false });
    });

    test("a leading `./` comes off a nested path too", () => {
        expect(resolve("./reports/one.sarif").path).toBe(`${BUILD}/reports/one.sarif`);
    });
});

describe("resolveArtifactPath: what it refuses", () => {
    for (const input of ["..", "../x", "a/../b", "a/.."]) {
        test(`'${input}' escapes the build directory`, () => {
            expect(() => resolve(input)).toThrow(ArtifactPathRefused);
        });
    }

    for (const input of ["a/./b", "a/.", "././a"]) {
        test(`'${input}' carries a '.' segment upload-artifact refuses`, () => {
            expect(() => resolve(input)).toThrow(ArtifactPathRefused);
        });
    }

    test("a newline is a second path uploaded, with nothing in the run saying so", () => {
        expect(() => resolve("findings.json\nrun.json")).toThrow(ArtifactPathRefused);
    });

    test("a dot inside a name escapes nothing and is kept", () => {
        expect(resolve("tool-semgrep..json").path).toBe(`${BUILD}/tool-semgrep..json`);
    });
});
