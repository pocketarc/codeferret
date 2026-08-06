import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "post-review.ts");

const REVIEW_URL = "https://github.com/o/r/pull/1#pullrequestreview-1";

/**
 * Every GitHub call answered with a posted review.
 *
 * DRY_RUN would be the cheap way to run the script, and it returns before the file is
 * written back, which is the half these tests are about.
 */
const PRELOAD = `
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.github.com")) {
        return new Response(JSON.stringify({ html_url: ${JSON.stringify(REVIEW_URL)} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }
    return real(input, init);
};
`;

const DECLINED_URL = "https://github.com/o/r/pull/1#issuecomment-999";

function finding(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
        found_by: ["caveman-review"],
        file: "a.ts",
        line: 1,
        severity: "high",
        category: "correctness",
        title: "A finding",
        body: "What is wrong with it.",
        status: "new",
        ...overrides,
    };
}

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeferret-post-"));
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

interface Written {
    findings: Array<Record<string, unknown>>;
    posted?: { url?: string; pr?: string };
}

/** Post one run for real against the stub, and hand back the file it left behind. */
async function post(
    findings: Array<Record<string, unknown>>,
    existing: Record<string, unknown>,
): Promise<{ written: Written; stderr: string }> {
    const findingsPath = join(dir, "findings.json");
    const preloadPath = join(dir, "stub-fetch.js");

    await Bun.write(findingsPath, `${JSON.stringify({ summary: "a run", findings }, null, 2)}\n`);
    await Bun.write(join(dir, "existing.json"), `${JSON.stringify(existing, null, 2)}\n`);
    await Bun.write(preloadPath, PRELOAD);

    const run = Bun.spawnSync(["bun", "--preload", preloadPath, SCRIPT, findingsPath, "deadbeef", "1"], {
        env: { ...process.env, GITHUB_TOKEN: "stub", GITHUB_REPOSITORY: "o/r", DRY_RUN: "" },
        stdin: "ignore",
    });

    return {
        written: (await Bun.file(findingsPath).json()) as Written,
        stderr: run.stderr.toString(),
    };
}

const strangerDeclined = finding({
    title: "Declined by a stranger",
    status: "declined",
    existing_comment_url: DECLINED_URL,
});

const strangerSaidSo = {
    threads: [],
    conversation: [{ author: "stranger", association: "NONE", body: "working as intended", url: DECLINED_URL }],
};

describe("post-review: the statuses written back to the findings file", () => {
    test("writes back the status vetDeclines reopened, not the one the orchestrator sent", async () => {
        const { written, stderr } = await post([strangerDeclined], strangerSaidSo);

        expect(stderr).toContain("Reporting them as new");
        expect(written.findings).toEqual([{ ...strangerDeclined, status: "new" }]);
    });

    test("leaves a decline an owner settled declined", async () => {
        const { written } = await post([strangerDeclined], {
            threads: [],
            conversation: [
                { author: "maintainer", association: "OWNER", body: "a.ts is meant to be that way", url: DECLINED_URL },
            ],
        });

        expect(written.findings[0]?.status).toBe("declined");
    });

    test("records the review it posted", async () => {
        const { written } = await post([finding({})], { threads: [], conversation: [] });

        expect(written.posted?.url).toBe(REVIEW_URL);
        expect(written.posted?.pr).toBe("1");
    });
});
