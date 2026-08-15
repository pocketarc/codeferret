import { describe, expect, test } from "bun:test";
import { planResolution } from "./existing.ts";

const MINE = new Set(["T_mine", "T_also-mine"]);

const ask = (id: string) => ({ thread_id: id, reason: "the defect is gone" });

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
