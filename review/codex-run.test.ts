import { beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "./json.ts";
import { rawFinding } from "./test-fixtures.ts";

const action = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "codeferret-codex-test-"));
const workspace = join(root, "repo");
const bin = join(root, "bin");
let runs = 0;

beforeAll(() => {
    mkdirSync(workspace);
    mkdirSync(bin);
    const git = (...args: string[]): void => {
        const result = Bun.spawnSync(["git", "-c", "user.email=test@example.test", "-c", "user.name=Test", ...args], { cwd: workspace });
        if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    };
    git("init", "--quiet", "--initial-branch", "main");
    writeFileSync(join(workspace, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "--quiet", "-m", "test: Add the initial fixture.");
    git("branch", "base");
    writeFileSync(join(workspace, "a.txt"), "two\n");
    git("add", "a.txt");
    git("commit", "--quiet", "-m", "test: Change the fixture.");
    const fixture = JSON.stringify(rawFinding({ file: "a.txt", found_by: ["codeferret:writing-review"] }));
    const stub = join(bin, "codex");
    writeFileSync(stub, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "login") {
    console.error(process.env.CF_TEST_MODE === "api-login" ? "Logged in using an API key" : "Logged in using ChatGPT");
    process.exit(0);
}
const prompt = await Bun.stdin.text();
const schema = args[args.indexOf("--output-schema") + 1];
const merge = schema.endsWith("codex-merged-schema.json");
const lens = merge ? "merge" : prompt.includes("skills/comment-review/SKILL.md") ? "comment-review" : "writing-review";
writeFileSync(process.env.CF_TEST_OUT + "/" + lens + ".json", JSON.stringify({ args, prompt, cwd: process.cwd(), env: process.env }));
const emit = event => console.log(JSON.stringify(event));
emit({ type: "turn.started" });
const mode = process.env.CF_TEST_MODE;
if (mode === "all-fail" || (mode === "partial" && lens === "comment-review")) {
    emit({ type: "turn.failed", error: { message: "Subscription limit reached." } });
    process.exit(1);
}
if (mode === "timeout") await Bun.sleep(5000);
const result = merge
    ? { summary: "Fixture review.", findings: [${fixture}], lens_health: [
        { lens: "comment-review", findings_returned: 0, ok: true, detail: "Fixture checked." },
        { lens: "writing-review", findings_returned: 0, ok: true, detail: "Fixture checked." }
      ], notes: null, resolve: null }
    : { skill_name: lens, findings: [], notes: mode === "silent" ? null : "Read the diff and checked the fixture." };
emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } });
if (mode !== "truncated") emit({ type: "turn.completed", usage: { output_tokens: 7 } });
`);
    chmodSync(stub, 0o755);
    writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
});

function review(mode = "ok", extra: Record<string, string> = {}) {
    const out = join(root, `run-${++runs}`);
    const capture = join(root, `capture-${runs}`);
    mkdirSync(capture);
    const result = Bun.spawnSync(["bash", join(action, "review/run.sh"), "base", action, out, workspace], {
        env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: process.env.HOME ?? "",
            REVIEW_ENGINE: "codex",
            LENSES: "comment-review\nwriting-review",
            CF_TEST_OUT: capture,
            CF_TEST_MODE: mode,
            GITHUB_TOKEN: "fixture-github-token",
            CODEX_API_KEY: "fixture-api-key",
            ...extra,
        },
    });
    const build = (name: string): string | null => {
        const path = join(out, "build", name);
        return existsSync(path) ? readFileSync(path, "utf8") : null;
    };
    return { status: result.exitCode, stderr: new TextDecoder().decode(result.stderr), build, capture,
        findings: record(JSON.parse(build("findings.json") ?? "null")) };
}

test("runs Codex lenses through shared validation and records subscription usage", () => {
    const run = review();
    expect(run.status).toBe(0);
    expect(run.build("findings-checked")).toBe("ok");
    expect(run.build("findings-count")).toBe("1");
    expect(run.build("output-tokens")).toBe("21");
    expect(run.build("cost-usd")).toBe("unknown");
    expect(run.findings?.lens_health).toEqual([
        { lens: "codeferret:comment-review", findings_returned: 0, ok: true, detail: "Fixture checked." },
        { lens: "codeferret:writing-review", findings_returned: 0, ok: true, detail: "Fixture checked." },
    ]);
    const capture = record(JSON.parse(readFileSync(join(run.capture, "writing-review.json"), "utf8")));
    expect(capture?.cwd).not.toBe(workspace);
    expect(JSON.stringify(capture?.env)).not.toContain("fixture-github-token");
    expect(JSON.stringify(capture?.env)).not.toContain("fixture-api-key");
    expect(capture?.prompt).toContain("skills/writing-review/SKILL.md");
    expect(capture?.prompt).not.toContain("Load the `codeferret:writing-review` skill");
});

test("retains a checked partial review and prevents the merger from hiding a failed lens", () => {
    const run = review("partial");
    expect(run.status).toBe(1);
    expect(run.build("findings-checked")).toBe("ok");
    const health = run.findings?.lens_health;
    expect(Array.isArray(health) && record(health[0])?.ok).toBe(false);
    expect(JSON.stringify(health)).toContain("Subscription limit reached.");
    expect(run.build("output-tokens")).toBe("unknown");
});

test("does not merge or mark an entirely failed, silent or truncated review as checked", () => {
    for (const mode of ["all-fail", "silent", "truncated"]) {
        const run = review(mode);
        expect(run.status).toBe(1);
        expect(run.build("findings-checked")).toBeNull();
        expect(existsSync(join(run.capture, "merge.json"))).toBe(false);
    }
});

test("stops timed-out lens processes and records an unsuccessful review", () => {
    const started = Date.now();
    const run = review("timeout", { CODEX_TIMEOUT_MS: "200" });
    expect(run.status).toBe(1);
    expect(run.build("findings-checked")).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
});

test("rejects invalid settings before a Codex process starts", () => {
    const run = review("ok", { CODEX_CONCURRENCY: "0" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("CODEX_CONCURRENCY");
    expect(existsSync(join(run.capture, "comment-review.json"))).toBe(false);
});

test("the local entry point requires subscription auth and preserves the Claude result", () => {
    const capture = join(root, "local-capture");
    const claude = join(workspace, ".git/codeferret/run");
    mkdirSync(capture);
    mkdirSync(claude, { recursive: true });
    writeFileSync(join(claude, "saved.txt"), "Claude result");
    const run = (mode: string) => Bun.spawnSync(["bash", join(action, "review/codex.sh"), "run", "base", "comment-review", "writing-review"], {
        cwd: workspace,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? "",
            CF_TEST_OUT: capture, CF_TEST_MODE: mode },
    });
    const rejected = run("api-login");
    expect(rejected.exitCode).toBe(1);
    expect(new TextDecoder().decode(rejected.stderr)).toContain("ChatGPT login");
    expect(existsSync(join(capture, "merge.json"))).toBe(false);
    const accepted = run("ok");
    expect(accepted.exitCode).toBe(0);
    expect(readFileSync(join(workspace, ".git/codeferret/codex-run/build/findings-checked"), "utf8")).toBe("ok");
    expect(readFileSync(join(claude, "saved.txt"), "utf8")).toBe("Claude result");
});
