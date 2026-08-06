// The decisions here are the ones whose failure nobody sees: a wrong answer suppresses a
// finding for as long as the pull request lasts, and neither the review nor the log shows
// it. So each is pinned against the shapes the artifacts endpoint really returns.

import { describe, expect, test } from "bun:test";
import { candidates, firstPosted, fromThisRepository, postedFor, previousOf, sameWorkflow } from "./previous.ts";
import type { Artifact } from "./previous.ts";

function artifact(over: Partial<Artifact> & { run?: Record<string, unknown> } = {}): Artifact {
    const { run, ...rest } = over;

    return {
        id: 1,
        name: "codeferret-run",
        expired: false,
        created_at: "2026-01-02T00:00:00Z",
        size_in_bytes: 100,
        workflow_run: { id: 9, head_branch: "feat/x", repository_id: 5, head_repository_id: 5, ...run },
        ...rest,
    };
}

function posted(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        posted: { at: "2026-01-02T00:00:00Z", url: "https://example.test/r/1", pr: "7" },
        findings: [{ file: "a.ts", line: 4, title: "A title", status: "new" }],
        ...over,
    };
}

describe("fromThisRepository", () => {
    test("takes a run whose two repository ids match", () => {
        expect(fromThisRepository({ repository_id: 5, head_repository_id: 5 })).toBe(true);
    });

    test("refuses a fork run, whose head repository is another one", () => {
        expect(fromThisRepository({ repository_id: 5, head_repository_id: 6 })).toBe(false);
    });

    test("refuses a run missing either id, so a field GitHub stopped sending fails safe", () => {
        expect(fromThisRepository({ repository_id: 5 })).toBe(false);
        expect(fromThisRepository({})).toBe(false);
        expect(fromThisRepository(undefined)).toBe(false);
    });
});

describe("sameWorkflow", () => {
    test("takes a run of the workflow now running", () => {
        expect(sameWorkflow(42, { workflow_id: 42 })).toBe(true);
    });

    test("refuses a run of the throwaway workflow somebody pushed to upload an artifact", () => {
        expect(sameWorkflow(42, { workflow_id: 99 })).toBe(false);
    });

    test("refuses a run that names no workflow at all", () => {
        expect(sameWorkflow(42, {})).toBe(false);
        expect(sameWorkflow(42, null)).toBe(false);
    });

    test("takes any run in a session, where nothing names a workflow to compare against", () => {
        expect(sameWorkflow(null, { workflow_id: 99 })).toBe(true);
    });
});

describe("postedFor", () => {
    test("takes a record naming this pull request", () => {
        expect(postedFor({ at: "2026-01-02T00:00:00Z", pr: "7" }, "7")).toBe("2026-01-02T00:00:00Z");
    });

    test("refuses another pull request's review, which the branch alone would let through", () => {
        expect(postedFor({ at: "2026-01-02T00:00:00Z", pr: "8" }, "7")).toBeNull();
    });

    test("refuses a record from a version that wrote no number", () => {
        expect(postedFor({ at: "2026-01-02T00:00:00Z" }, "7")).toBeNull();
    });

    test("refuses an absent or empty timestamp", () => {
        expect(postedFor(undefined, "7")).toBeNull();
        expect(postedFor({ pr: "7" }, "7")).toBeNull();
        expect(postedFor({ at: "   ", pr: "7" }, "7")).toBeNull();
    });
});

describe("candidates", () => {
    test("drops this run's own earlier upload, which a re-run lists under the same id", () => {
        const list = candidates([artifact({ id: 1, run: { id: 9 } }), artifact({ id: 2, run: { id: 8 } })], "feat/x", 9);

        expect(list.map((a) => a.id)).toEqual([2]);
    });

    test("keeps everything when no run id names this run", () => {
        const list = candidates(
            [artifact({ id: 1, run: { id: 9 } }), artifact({ id: 2, run: { id: 8 } })],
            "feat/x",
            Number.NaN,
        );

        expect(list.map((a) => a.id)).toEqual([1, 2]);
    });

    test("drops another branch, an expired artifact and a fork's upload", () => {
        const list = candidates(
            [
                artifact({ id: 1, run: { head_branch: "other" } }),
                artifact({ id: 2, expired: true }),
                artifact({ id: 3, run: { head_repository_id: 6 } }),
                artifact({ id: 4 }),
            ],
            "feat/x",
            Number.NaN,
        );

        expect(list.map((a) => a.id)).toEqual([4]);
    });

    test("orders newest first, whatever order the page arrived in", () => {
        const list = candidates(
            [
                artifact({ id: 1, created_at: "2026-01-01T00:00:00Z" }),
                artifact({ id: 2, created_at: "2026-01-03T00:00:00Z" }),
            ],
            "feat/x",
            Number.NaN,
        );

        expect(list.map((a) => a.id)).toEqual([2, 1]);
    });
});

describe("previousOf", () => {
    test("reads back the fields the orchestrator matches on", () => {
        expect(previousOf(posted(), "7", "artifact 1")).toEqual([
            { file: "a.ts", line: 4, title: "A title", status: "new" },
        ]);
    });

    test("is null when no review of this pull request was recorded", () => {
        expect(previousOf(posted({ posted: undefined }), "7", "artifact 1")).toBeNull();
        expect(previousOf(posted({ posted: { at: "2026-01-02T00:00:00Z", pr: "8" } }), "7", "artifact 1")).toBeNull();
    });

    test("throws when the file is not a findings file", () => {
        expect(() => previousOf({ findings: "no" }, "7", "artifact 1")).toThrow("no findings array");
    });

    test("leaves out a line that is not one, and keeps the finding", () => {
        const entry = previousOf(
            posted({ findings: [{ file: "a.ts", line: 0.5, title: "T", status: "declined" }] }),
            "7",
            "artifact 1",
        );

        expect(entry).toEqual([{ file: "a.ts", title: "T", status: "declined" }]);
    });

    test("reads a status nothing recognises as new, the way the schema asks", () => {
        const entry = previousOf(posted({ findings: [{ file: "a.ts", title: "T", status: 7 }] }), "7", "artifact 1");

        expect(entry?.[0]?.status).toBe("new");
    });

    test("skips an entry with no file or no title, which nothing could match", () => {
        const entry = previousOf(posted({ findings: [{ file: "a.ts" }, "broken"] }), "7", "artifact 1");

        expect(entry).toEqual([]);
    });
});

describe("firstPosted", () => {
    test("steps over a run whose review never landed and takes the one before it", async () => {
        const said: string[] = [];
        const files: Record<number, unknown> = { 1: posted({ posted: undefined }), 2: posted() };

        const found = await firstPosted(
            [artifact({ id: 1 }), artifact({ id: 2 })],
            "7",
            async (a) => files[a.id],
            10,
            (line) => said.push(line),
        );

        expect(found?.from.id).toBe(2);
        expect(said.join(" ")).toContain("artifact 1 records no posted review");
    });

    test("carries on past an artifact it could not read", async () => {
        const said: string[] = [];

        const found = await firstPosted(
            [artifact({ id: 1 }), artifact({ id: 2 })],
            "7",
            async (a) => {
                if (a.id === 1) throw new Error("HTTP 404");
                return posted();
            },
            10,
            (line) => said.push(line),
        );

        expect(found?.from.id).toBe(2);
        expect(said.join(" ")).toContain("HTTP 404");
    });

    test("gives up rather than downloading the whole retention window", async () => {
        const said: string[] = [];
        let opened = 0;

        const found = await firstPosted(
            Array.from({ length: 20 }, (_, i) => artifact({ id: i + 1 })),
            "7",
            async () => {
                opened += 1;
                return posted({ posted: undefined });
            },
            3,
            (line) => said.push(line),
        );

        expect(found).toBeNull();
        expect(opened).toBe(3);
        expect(said.join(" ")).toContain("gave up after opening 3 artifacts");
    });

    test("is null when there is nothing to open", async () => {
        expect(await firstPosted([], "7", async () => posted(), 10, () => {})).toBeNull();
    });
});
