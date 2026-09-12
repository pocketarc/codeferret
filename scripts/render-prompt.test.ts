import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "render-prompt.ts");

type Run = { code: number; out: string; err: string };

async function render(template: string, args: string[], files: Record<string, string> = {}): Promise<Run> {
    const dir = mkdtempSync(join(tmpdir(), "render-prompt-"));
    const templatePath = join(dir, "template.md");
    const outPath = join(dir, "out.txt");

    writeFileSync(templatePath, template);

    const resolved = args.map((arg) => {
        const at = arg.indexOf("@");

        if (at < 1 || arg.slice(0, at).includes("=")) {
            return arg;
        }

        const name = arg.slice(0, at);
        const file = join(dir, `${name}.block`);

        writeFileSync(file, files[arg.slice(at + 1)] ?? "");

        return `${name}@${file}`;
    });

    const proc = Bun.spawn(["bun", "--config=/dev/null", SCRIPT, templatePath, outPath, ...resolved], {
        stdout: "pipe",
        stderr: "pipe",
    });

    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    const out = code === 0 ? await Bun.file(outPath).text() : "";

    return { code, out, err };
}

describe("render-prompt", () => {
    test("fills a placeholder with its value", async () => {
        const r = await render("diff __BASE__ against __HEAD__\n", ["__BASE__=main", "__HEAD__=abc123"]);

        expect(r.code).toBe(0);
        expect(r.out).toBe("diff main against abc123\n");
    });

    test("splices a block over the whole line the name sits on", async () => {
        const r = await render("before\n__LIST__\nafter\n", ["__LIST__@list"], { list: "one\ntwo" });

        expect(r.code).toBe(0);
        expect(r.out).toBe("before\none\ntwo\nafter\n");
    });

    // The regression this file exists for. `plain_ref` allows every character in a
    // placeholder name, so a base branch may legally be called `__DISPATCH__`. Substituting
    // values and then splicing, as two passes, fed the inserted name straight into the
    // splice and replaced the base-ref line with the whole dispatch block. Nothing was left
    // over, so the leftover check passed and the prompt was wrong about what to diff.
    test("a value that is itself a placeholder name is not spliced over", async () => {
        const r = await render("diff against __BASE__\n__DISPATCH__\n", ["__BASE__=__DISPATCH__", "__DISPATCH__@d"], {
            d: "GO REVIEW THINGS",
        });

        expect(r.code).toBe(0);
        expect(r.out).toBe("diff against __DISPATCH__\nGO REVIEW THINGS\n");
    });

    test("a value that is itself a placeholder name is not substituted again", async () => {
        const r = await render("__A__ then __B__\n", ["__A__=__B__", "__B__=filled"]);

        expect(r.code).toBe(0);
        expect(r.out).toBe("__B__ then filled\n");
    });

    test("substitution does not depend on argument order", async () => {
        const forward = await render("__A__ then __B__\n", ["__A__=__B__", "__B__=filled"]);
        const backward = await render("__A__ then __B__\n", ["__B__=filled", "__A__=__B__"]);

        expect(forward.out).toBe(backward.out);
    });

    test("a replacement holding $& or $1 goes in verbatim", async () => {
        const r = await render("range __RANGE__\n", ["__RANGE__=$& and $1 and $`"]);

        expect(r.code).toBe(0);
        expect(r.out).toBe("range $& and $1 and $` \n".replace(" \n", "\n"));
    });

    test("an unfilled placeholder fails rather than reaching the prompt", async () => {
        const r = await render("diff __BASE__ against __HEAD__\n", ["__BASE__=main"]);

        expect(r.code).toBe(1);
        expect(r.err).toContain("__HEAD__");
    });

    test("a name that is not placeholder-shaped is refused", async () => {
        const r = await render("hello BASE\n", ["BASE=main"]);

        expect(r.code).toBe(2);
        expect(r.err).toContain("__NAME__");
    });

    test("--indent pads every non-empty line and leaves blank lines bare", async () => {
        const r = await render("a\n\nb\n", ["__X__=unused"].slice(1).concat(["--indent", "2"]));

        expect(r.code).toBe(0);
        expect(r.out).toBe("  a\n\n  b\n");
    });
});
