import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMerged } from "./read-run.ts";

const dir = mkdtempSync(join(tmpdir(), "codeferret-read-run-"));

async function fileHolding(name: string, text: string): Promise<string> {
    const path = join(dir, name);

    await Bun.write(path, text);

    return path;
}

describe("readMerged: a run's findings file, or why it could not be read", () => {
    test("reads a well-formed file", async () => {
        const finding = { title: "a", file: "src/a.ts", body: "b" };
        const path = await fileHolding("good.json", JSON.stringify({ findings: [finding] }));
        const read = await readMerged(path);

        expect(read.ok).toBe(true);
        expect(read.ok && read.value.findings).toEqual([finding]);
    });

    test("names the file and the parse error rather than throwing", async () => {
        const path = await fileHolding("truncated.json", '{"findings":[');
        const read = await readMerged(path);

        expect(read.ok).toBe(false);
        expect(read.ok === false && read.message.startsWith(`${path}: `)).toBe(true);
    });

    // The loosest gate that still refuses a file nothing can read as a run's output. Tightening
    // it here would trade one malformed finding for the whole review; check-findings.ts repairs
    // and drops a finding at a time instead.
    test("a file with no findings array is refused by name", async () => {
        const path = await fileHolding("shapeless.json", '{"summary":"all done"}');

        expect(await readMerged(path)).toEqual({ ok: false, message: `${path}: has no \`findings\` array` });
    });

    test("a file that is not there is refused rather than read as empty", async () => {
        const path = join(dir, "absent.json");
        const read = await readMerged(path);

        expect(read.ok).toBe(false);
    });
});
