import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asExisting, ownThreads, planResolution, readExisting, survey, unreadOf } from "./existing.ts";

const MINE = new Set(["T_mine", "T_also-mine"]);

const ask = (id: string) => ({ thread_id: id, reason: "the defect is gone" });

/** Built through the parser, so a test cannot assert about a value no run can produce. */
const file = (value: unknown) => asExisting(value);

describe("planResolution: which threads a run may close", () => {
    test("closes the ones this run opened and leaves the rest alone", () => {
        expect(planResolution([ask("T_mine"), ask("T_theirs")], MINE, true)).toEqual({
            close: [ask("T_mine")],
            foreign: [ask("T_theirs")],
        });
    });

    // The shipped default. `resolve-threads` is off unless a caller turns it on, and a caller
    // who forgets closes no thread rather than closing one nobody sanctioned.
    test("closes nothing at all when resolving is off, whatever the orchestrator asked", () => {
        expect(planResolution([ask("T_mine"), ask("T_theirs")], MINE, false)).toEqual({
            close: [],
            foreign: [],
        });
    });

    test("an orchestrator that asked for nothing plans nothing", () => {
        expect(planResolution([], MINE, true)).toEqual({ close: [], foreign: [] });
    });

    // `mine` takes both a login and a hidden marker, and it comes back empty whenever a run
    // posts under an account that cannot tell its own threads from a person's.
    test("no thread is this run's when nothing is marked mine", () => {
        expect(planResolution([ask("T_mine")], new Set(), true)).toEqual({
            close: [],
            foreign: [ask("T_mine")],
        });
    });
});

describe("ownThreads: which threads this tool opened", () => {
    test("takes a thread marked mine with an id", () => {
        expect(ownThreads(file({ threads: [{ thread_id: "T_1", mine: true }] }))).toEqual(new Set(["T_1"]));
    });

    test("refuses a truthy `mine` that is not the boolean", () => {
        expect(ownThreads(file({ threads: [{ thread_id: "T_1", mine: "true" }] }))).toEqual(new Set());
    });

    test("refuses a thread with no `mine` at all", () => {
        expect(ownThreads(file({ threads: [{ thread_id: "T_1" }] }))).toEqual(new Set());
    });

    // `thread_id` is optional here and unvalidated in the orchestrator's `resolve` entries, so
    // without the guard `undefined` enters the set, matches an asked entry that also lacks one,
    // and `post-review.ts` closes a thread nobody identified.
    test("refuses an id that is not a string, absent included", () => {
        expect(ownThreads(file({ threads: [{ thread_id: 7, mine: true }] }))).toEqual(new Set());
        expect(ownThreads(file({ threads: [{ mine: true }] }))).toEqual(new Set());
    });

    test("reads a file with no threads as none of this run's", () => {
        expect(ownThreads(file({}))).toEqual(new Set());
    });

    test("separates this run's threads from everyone else's", () => {
        const existing = file({
            threads: [
                { thread_id: "T_mine", mine: true },
                { thread_id: "T_theirs", mine: false },
            ],
        });

        expect(planResolution([ask("T_mine"), ask("T_theirs")], ownThreads(existing), true)).toEqual({
            close: [ask("T_mine")],
            foreign: [ask("T_theirs")],
        });
    });
});

describe("survey: what the pull request carries", () => {
    const EXISTING = file({
        threads: [
            {
                file: "src/auth.ts",
                resolved: true,
                comments: [
                    { url: "u1", body: "working as intended", association: "MEMBER" },
                    { url: "u2", body: "agreed" },
                ],
            },
            { file: "src/pay.ts", comments: [{ url: "u3", body: "still open" }] },
        ],
        conversation: [{ url: "u4", body: "LGTM", association: "OWNER" }],
    });

    test("a thread comment carries its thread's file and whether the thread is closed", () => {
        expect(survey(EXISTING).comments.get("u1")).toEqual({
            file: "src/auth.ts",
            text: "working as intended",
            association: "MEMBER",
            onClosedThread: true,
        });
    });

    // The open thread carries no `resolved` key at all, which is the shape a fetch leaves and
    // what `=== true` is there for.
    test("a comment on an open thread is not on a closed one", () => {
        expect(survey(EXISTING).comments.get("u3")?.onClosedThread).toBe(false);
    });

    // An OWNER "LGTM" anchored to nothing, which is the case `isAbout` exists to stop from
    // settling every finding on the pull request.
    test("a conversation comment carries no file and no closed thread", () => {
        expect(survey(EXISTING).comments.get("u4")).toEqual({
            file: "",
            text: "LGTM",
            association: "OWNER",
            onClosedThread: false,
        });
    });

    test("an absent body and an absent association read as empty rather than undefined", () => {
        expect(survey(EXISTING).comments.get("u2")).toEqual({
            file: "src/auth.ts",
            text: "agreed",
            association: "",
            onClosedThread: true,
        });
    });

    // The set of urls the body may link was held beside this map and could only ever equal its
    // keys, because one line added to both. `post-review.ts` derives it where it needs it.
    test("drops a comment with no url, which is the only thing that can be linked", () => {
        expect(survey(file({ conversation: [{ body: "no url" }] })).comments.size).toBe(0);
    });
});

describe("unreadOf: what the fetch could not read", () => {
    test("says nothing when both halves came back", () => {
        expect(unreadOf(file({ threads: [], conversation: [] }))).toEqual([]);
    });

    test("reports either half in the words the fetch wrote", () => {
        expect(unreadOf(file({ error: "threads: 502" }))).toEqual(["threads: 502"]);
        expect(unreadOf(file({ conversation_error: "comments: 502" }))).toEqual(["comments: 502"]);
    });

    test("reports both halves, threads first", () => {
        expect(unreadOf(file({ error: "threads: 502", conversation_error: "comments: 502" }))).toEqual([
            "threads: 502",
            "comments: 502",
        ]);
    });

    test("ignores a reason that is not a string", () => {
        expect(unreadOf(file({ error: 502, conversation_error: { code: 502 } }))).toEqual([]);
    });
});

describe("asExisting: the file as every reader is handed it", () => {
    test("guarantees both lists whatever is on disk", () => {
        expect(asExisting({ threads: "not a list" })).toEqual({ threads: [], conversation: [] });
        expect(asExisting(null)).toEqual({ threads: [], conversation: [] });
        expect(asExisting("[]")).toEqual({ threads: [], conversation: [] });
    });

    test("keeps the lists and the reasons a real file carries", () => {
        expect(asExisting({ threads: [{ thread_id: "T_1" }], conversation: [], error: "502" })).toEqual({
            threads: [{ thread_id: "T_1" }],
            conversation: [],
            error: "502",
        });
    });
});

describe("readExisting: the file beside a run's findings", () => {
    let dir = "";

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), "codeferret-existing-"));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("reads a real file", async () => {
        const home = join(dir, "good");
        mkdirSync(home);
        writeFileSync(join(home, "existing.json"), JSON.stringify({ threads: [{ thread_id: "T_1" }], conversation: [] }));

        expect(await readExisting(home, () => expect.unreachable())).toEqual({
            threads: [{ thread_id: "T_1" }],
            conversation: [],
        });
    });

    test("a missing file says nothing, and says nothing about it either", async () => {
        expect(await readExisting(join(dir, "absent"), () => expect.unreachable())).toEqual({
            threads: [],
            conversation: [],
        });
    });

    // Half a file is what a killed fetch leaves, and the caller's line is the only thing that
    // tells a reader every suppression was reopened.
    test("a file that will not parse says nothing, and reports why", async () => {
        const home = join(dir, "torn");
        mkdirSync(home);
        writeFileSync(join(home, "existing.json"), '{"threads": [');

        const said: string[] = [];

        expect(await readExisting(home, (line) => said.push(line))).toEqual({ threads: [], conversation: [] });
        expect(said).toHaveLength(1);
        expect(said[0]).toContain("existing.json");
    });
});
