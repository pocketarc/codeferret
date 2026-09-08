import { describe, expect, test } from "bun:test";
import { asExisting, survey } from "./existing.ts";
import { isPrinted, lineOf, partition, vetSuppression } from "./findings.ts";
import type { Finding } from "./findings.ts";
import { filesRaisedBefore } from "./previous.ts";
import { REVIEW_THRESHOLD } from "./read-run.ts";
import { meetsThreshold, TIER_NAMES } from "./risk.ts";
import { finding, NO_RISK, riskFor } from "./test-fixtures.ts";

const LISTED_TIERS = TIER_NAMES.filter((tier) => meetsThreshold(tier, REVIEW_THRESHOLD));
const UNLISTED_TIERS = TIER_NAMES.filter((tier) => !meetsThreshold(tier, REVIEW_THRESHOLD));

test("both sides of the threshold have a tier, so no loop below runs over nothing", () => {
    expect(LISTED_TIERS.length).toBeGreaterThan(0);
    expect(UNLISTED_TIERS.length).toBeGreaterThan(0);
});

/**
 * `vetSuppression` against a case written as the file on disk.
 *
 * It takes the walked discussion and the set of files the last review raised something in,
 * because the caller that posts has both already and doing either twice is a second answer. A
 * case here is still clearest written as the two JSON documents, so the narrowing happens at
 * this boundary instead.
 */
const vet = (
    findings: Finding[],
    existing: unknown,
    previous?: unknown,
    /** An artifact run by default, which is where the threshold decides anything. */
    deferrable = true,
): ReturnType<typeof vetSuppression> =>
    vetSuppression(findings, survey(asExisting(existing)), filesRaisedBefore(previous), REVIEW_THRESHOLD, deferrable);

describe("partition", () => {
    test("splits on status and orders by risk", () => {
        const { all, fresh, suppressed, declined } = partition([
            finding({ title: "low", risk: riskFor("low") }),
            finding({ title: "seen", status: "already-reported" }),
            finding({ title: "crit", risk: riskFor("critical") }),
            finding({ title: "no", status: "declined" }),
        ]);

        expect(all.map((f) => f.title)).toEqual(["crit", "low", "seen", "no"]);
        expect(fresh.map((f) => f.title)).toEqual(["crit", "low"]);
        expect(suppressed.map((f) => f.title)).toEqual(["seen"]);
        expect(declined.map((f) => f.title)).toEqual(["no"]);
    });

    test("sorts a finding whose rating failed with the worst, since the body prints it either way", () => {
        const { all } = partition([
            finding({ title: "nit", risk: riskFor("nit") }),
            finding({ title: "unrated", risk: undefined }),
            finding({ title: "crit", risk: riskFor("critical") }),
        ]);

        expect(all.map((f) => f.title)).toEqual(["unrated", "crit", "nit"]);
    });
});

describe("lineOf", () => {
    test("gives back a line a reader can be sent to", () => {
        expect(lineOf(finding({ line: 12 }))).toBe(12);
    });

    // `POLICY` in finding-rules.ts tolerates each of these and keeps the finding, so every
    // reader has to answer without one, and a reader following `path:0` from a terminal
    // arrives nowhere.
    test("gives back nothing for a line no reader could be sent to", () => {
        expect(lineOf(finding({ line: undefined }))).toBeUndefined();
        expect(lineOf(finding({ line: 0 }))).toBeUndefined();
        expect(lineOf(finding({ line: -3 }))).toBeUndefined();
        expect(lineOf(finding({ line: 1.5 }))).toBeUndefined();
    });
});

describe("the tier against the threshold", () => {
    test("lists everything at the threshold or above", () => {
        for (const tier of LISTED_TIERS) expect(isPrinted(finding({ risk: riskFor(tier) }), REVIEW_THRESHOLD, true)).toBe(true);
    });

    test("leaves out everything under it", () => {
        for (const tier of UNLISTED_TIERS) {
            expect(isPrinted(finding({ risk: riskFor(tier) }), REVIEW_THRESHOLD, true)).toBe(false);
        }
    });

    test("leaves out a finding rated as applying to nothing, which is an answer", () => {
        expect(isPrinted(finding({ risk: NO_RISK }), REVIEW_THRESHOLD, true)).toBe(false);
    });

    // The distinction this pins: `NO_RISK` above is a finding somebody rated, on every axis,
    // as touching nothing. These two are findings nobody managed to rate. Both score 0 and
    // band to `nit`, and the first version of this test asserted both were left out — so a
    // finding whose rating failed left the comment with nothing on the page saying so.
    test("prints a finding whose rating failed rather than hiding it on a tier it does not have", () => {
        expect(isPrinted(finding({ risk: undefined }), REVIEW_THRESHOLD, true)).toBe(true);
        expect(isPrinted(finding({ risk: { ...riskFor("nit"), impact: "catastophic" } }), REVIEW_THRESHOLD, true)).toBe(true);
    });
});

describe("what the body prints is what the bar protects", () => {
    const lowFinding = finding({ risk: riskFor("low") });

    test("a run with nothing to defer to prints every finding and protects every finding", () => {
        expect(isPrinted(lowFinding, REVIEW_THRESHOLD, false)).toBe(true);
    });

    test("a run with an artifact leaves a low finding to it, and the bar follows", () => {
        expect(isPrinted(lowFinding, REVIEW_THRESHOLD, true)).toBe(false);
    });

    test("a closed thread cannot settle a finding the reader is looking at", () => {
        const onClosed = {
            threads: [
                {
                    url: "https://github.com/o/r/pull/1#discussion_r1",
                    file: "a.ts",
                    mine: true,
                    resolved: true,
                    comments: [{ url: "https://github.com/o/r/pull/1#discussion_r1", body: "a.ts is fine", association: "NONE" }],
                },
            ],
            conversation: [],
        };

        const declined = [
            finding({ risk: riskFor("low"), status: "declined", existing_comment_url: "https://github.com/o/r/pull/1#discussion_r1" }),
        ];

        // Deferred to an artifact the finding is off the page; printed to a terminal it is not.
        expect(vet(declined, onClosed, undefined, true).findings[0]?.status).toBe("declined");
        expect(vet(declined, onClosed, undefined, false).findings[0]?.status).toBe("new");
    });
});

describe("vetSuppression: who may settle a finding", () => {
    const replyUrl = "https://github.com/o/r/pull/1#discussion_r2";

    const declined = (url?: string): Finding => finding({ status: "declined", existing_comment_url: url });

    function existing(association: string, resolved = false) {
        return {
            threads: [
                {
                    resolved,
                    file: "a.ts",
                    url: "https://github.com/o/r/pull/1#discussion_r1",
                    comments: [
                        { association: "NONE", url: "https://github.com/o/r/pull/1#discussion_r1", body: "raised" },
                        { association, url: "https://github.com/o/r/pull/1#discussion_r2", body: "intentional" },
                    ],
                },
            ],
        };
    }

    function existingWithPermission(permission: string) {
        return {
            threads: [
                {
                    resolved: false,
                    file: "a.ts",
                    url: "https://github.com/o/r/pull/1#discussion_r1",
                    comments: [
                        { association: "NONE", url: "https://github.com/o/r/pull/1#discussion_r1", body: "raised" },
                        {
                            association: "MEMBER",
                            repository_permission: permission,
                            url: "https://github.com/o/r/pull/1#discussion_r2",
                            body: "intentional",
                        },
                    ],
                },
            ],
        };
    }

    for (const association of ["OWNER", "COLLABORATOR"]) {
        test(`a reply from ${association} may decline`, () => {
            const out = vet([declined("https://github.com/o/r/pull/1#discussion_r2")], existing(association));

            expect([out.untraceable, out.unrelated]).toEqual([0, 0]);
            expect(out.findings[0]?.status).toBe("declined");
        });
    }

    for (const association of ["MEMBER", "NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", ""]) {
        test(`a reply from ${association || "no association"} may not`, () => {
            const out = vet([declined("https://github.com/o/r/pull/1#discussion_r2")], existing(association));

            expect(out.untraceable).toBe(1);
            expect(out.findings[0]?.status).toBe("new");
        });
    }

    for (const permission of ["admin", "maintain", "push", "write"]) {
        test(`a finding is suppressed when an organization member with ${permission} permission on the repository declines it`, () => {
            const out = vet(
                [declined("https://github.com/o/r/pull/1#discussion_r2")],
                existingWithPermission(permission),
            );

            expect([out.untraceable, out.unrelated]).toEqual([0, 0]);
            expect(out.findings[0]?.status).toBe("declined");
        });
    }

    test("a reply on a resolved thread settles a finding in that thread's own file", () => {
        const out = vet([declined("https://github.com/o/r/pull/1#discussion_r2")], existing("NONE", true));

        expect([out.untraceable, out.unrelated]).toEqual([0, 0]);
        expect(out.findings[0]?.status).toBe("declined");
    });

    // GitHub resolves a conversation for whoever opened the pull request as well as for
    // anyone with repository write, so a closed thread on an outside contributor's branch is
    // the word of the person under review.
    for (const tier of LISTED_TIERS) {
        test(`a resolved thread cannot decline a ${tier} finding on its own`, () => {
            const out = vet(
                [finding({ file: "a.ts", risk: riskFor(tier), status: "declined", existing_comment_url: replyUrl })],
                existing("NONE", true),
            );

            expect(out.untraceable).toBe(1);
            expect(out.findings[0]?.status).toBe("new");
        });

        test(`an owner's reply on that thread still declines a ${tier} finding`, () => {
            const out = vet(
                [finding({ file: "a.ts", risk: riskFor(tier), status: "declined", existing_comment_url: replyUrl })],
                existing("OWNER", true),
            );

            expect(out.findings[0]?.status).toBe("declined");
        });
    }

    test("a resolved thread declines a finding whose risk scores nothing, which is a nit", () => {
        const out = vet(
            [finding({ file: "a.ts", risk: NO_RISK, status: "declined", existing_comment_url: replyUrl })],
            existing("NONE", true),
        );

        expect(out.untraceable).toBe(0);
        expect(out.findings[0]?.status).toBe("declined");
    });

    test("that reply settles nothing in another file, whatever it names", () => {
        const anyone = existing("NONE", true);
        const comment = anyone.threads[0]?.comments[1];

        if (comment) comment.body = "src/elsewhere.ts is meant to be like that";

        const out = vet(
            [finding({ file: "src/elsewhere.ts", status: "declined", existing_comment_url: comment?.url })],
            anyone,
        );

        expect(out.unrelated).toBe(1);
        expect(out.findings[0]?.status).toBe("new");
    });

    test("a decline citing no comment is reopened", () => {
        expect(vet([declined()], existing("OWNER")).untraceable).toBe(1);
    });

    test("a decline citing a comment that is not there is reopened", () => {
        const out = vet([declined("https://github.com/o/r/pull/1#discussion_r9")], existing("OWNER"));

        expect(out.untraceable).toBe(1);
    });

    test("unreadable input reopens rather than accepts", () => {
        const out = vet([declined("https://github.com/o/r/pull/1#discussion_r2")], null);

        expect(out.untraceable).toBe(1);
    });

    test("it leaves a new finding alone", () => {
        const out = vet([finding({ status: "new" })], {});

        expect([out.untraceable, out.unrelated, out.unvouched, out.unreported, out.unmatched]).toEqual([
            0, 0, 0, 0, 0,
        ]);
        expect(out.findings.map((f) => f.status)).toEqual(["new"]);
    });
});

describe("vetSuppression: what already-reported rests on when it cites no comment", () => {
    const seen = (file = "a.ts"): Finding => finding({ file, status: "already-reported" });

    test("the previous review having raised something in the same file settles it", () => {
        const out = vet([seen()], {}, { findings: [{ file: "a.ts", title: "worded some other way" }] });

        expect(out.unmatched).toBe(0);
        expect(out.findings[0]?.status).toBe("already-reported");
    });

    test("a previous review of other files does not, and nothing else would have checked it", () => {
        const out = vet([seen()], {}, { findings: [{ file: "b.ts", title: "A title" }] });

        expect(out.unmatched).toBe(1);
        expect(out.findings[0]?.status).toBe("new");
    });

    test("no previous findings at all reopens, which is what a first run means", () => {
        expect(vet([seen()], {}, { findings: [] }).unmatched).toBe(1);
        expect(vet([seen()], {}).unmatched).toBe(1);
    });

    test("the title is not the key, because the orchestrator rewrites one every run", () => {
        const out = vet([seen()], {}, { findings: [{ file: "a.ts", title: "nothing like it" }] });

        expect(out.findings[0]?.status).toBe("already-reported");
    });
});

describe("vetSuppression: what already-reported has to rest on", () => {
    const seen = (file: string, url?: string): Finding =>
        finding({ file, status: "already-reported", existing_comment_url: url });

    const conversationUrl = "https://github.com/o/r/pull/1#issuecomment-1";

    const said = (body: string, association = "NONE") => ({
        conversation: [{ association, url: conversationUrl, body }],
    });

    test("a comment from anyone at all settles it, which is the whole point of the status", () => {
        const out = vet([seen("src/a.ts", conversationUrl)], said("src/a.ts has this already"));

        expect(out.unreported).toBe(0);
        expect(out.findings[0]?.status).toBe("already-reported");
    });

    test("an LGTM naming no file does not, and it would have settled every finding", () => {
        const out = vet([seen("src/a.ts", conversationUrl)], said("LGTM, merging"));

        expect(out.unreported).toBe(1);
        expect(out.findings[0]?.status).toBe("new");
    });

    test("a url no comment on the pull request carries does not", () => {
        const out = vet([seen("src/a.ts", "https://evil.test/x")], said("src/a.ts has this already"));

        expect(out.unreported).toBe(1);
    });
});

describe("vetSuppression: naming a file by its basename", () => {
    const url = "https://github.com/o/r/pull/1#issuecomment-1";

    const said = (body: string) => ({ conversation: [{ association: "OWNER", url, body }] });

    const declined = (file: string): Finding => finding({ file, status: "declined", existing_comment_url: url });

    test("a basename in ordinary prose settles the file it names", () => {
        expect(vet([declined("src/money.ts")], said("money.ts is deliberate")).unrelated).toBe(0);
    });

    test("a basename inside a longer word does not", () => {
        expect(vet([declined("src/money.ts")], said("see money.ts.bak")).unrelated).toBe(1);
        expect(vet([declined("src/cache")], said("the cached value is fine")).unrelated).toBe(1);
    });

    test("a basename too short to be more than prose needs the whole path", () => {
        expect(vet([declined("cmd/id")], said("the id is meant to be like that")).unrelated).toBe(1);
        expect(vet([declined("cmd/id")], said("cmd/id is meant to be like that")).unrelated).toBe(0);
    });

    test("a root-level file too short to be more than prose settles nothing", () => {
        expect(vet([declined("id")], said("the id column is fine")).unrelated).toBe(1);
    });

    test("a whole path inside a longer one does not settle it either", () => {
        expect(vet([declined("src/a.ts")], said("see apps/web/src/a.ts.bak")).unrelated).toBe(1);
    });
});

describe("vetSuppression: whether the comment is about the finding", () => {
    const declined = (file: string, url: string): Finding =>
        finding({ file, status: "declined", existing_comment_url: url });

    const url = "https://github.com/o/r/pull/1#discussion_r2";
    const conversationUrl = "https://github.com/o/r/pull/1#issuecomment-1";

    function thread(file: string, body = "intentional") {
        return {
            threads: [
                {
                    resolved: false,
                    file,
                    url: "https://github.com/o/r/pull/1#discussion_r1",
                    comments: [{ association: "OWNER", url, body }],
                },
            ],
        };
    }

    test("a reply on the finding's own thread settles it without naming anything", () => {
        expect(vet([declined("src/a.ts", url)], thread("src/a.ts")).unrelated).toBe(0);
    });

    test("a reply on a thread about another file does not", () => {
        const out = vet([declined("src/a.ts", url)], thread("src/b.ts"));

        expect([out.untraceable, out.unrelated]).toEqual([0, 1]);
        expect(out.findings[0]?.status).toBe("new");
    });

    test("a reply about another file still settles a finding it names", () => {
        expect(vet([declined("src/a.ts", url)], thread("src/b.ts", "src/a.ts is meant to be")).unrelated).toBe(
            0,
        );
    });

    test("an unrelated conversation comment from an owner settles nothing", () => {
        const lgtm = { conversation: [{ association: "OWNER", url: conversationUrl, body: "LGTM, merging" }] };
        const out = vet([declined("src/a.ts", conversationUrl)], lgtm);

        expect([out.untraceable, out.unrelated]).toEqual([0, 1]);
    });

    test("a conversation comment naming the file does settle it", () => {
        const named = {
            conversation: [{ association: "OWNER", url: conversationUrl, body: "the float in `money.ts` is deliberate" }],
        };

        expect(vet([declined("src/money.ts", conversationUrl)], named).unrelated).toBe(0);
    });

    test("a stranger naming the file settles nothing either", () => {
        const named = {
            conversation: [{ association: "NONE", url: conversationUrl, body: "src/a.ts is fine" }],
        };

        expect(vet([declined("src/a.ts", conversationUrl)], named).untraceable).toBe(1);
    });
});

describe("vetSuppression holds a listed finding to the decline bar", () => {
    const url = "https://github.com/o/r/pull/1#discussion_r1";

    const commented = (association: string) => ({
        threads: [
            {
                thread_id: "T",
                resolved: false,
                url,
                file: "a.ts",
                mine: false,
                comments: [{ author: "who", association, url, body: "known issue in a.ts" }],
            },
        ],
        conversation: [],
    });

    const reported = (risk: Finding["risk"]): Finding =>
        finding({ risk, status: "already-reported", existing_comment_url: url });

    for (const tier of LISTED_TIERS) {
        test(`a stranger's comment cannot demote a ${tier} finding`, () => {
            const out = vet([reported(riskFor(tier))], commented("NONE"));

            expect(out.findings[0]?.status).toBe("new");
            expect(out.unvouched).toBe(1);
        });

        test(`an owner's comment still settles a ${tier} finding`, () => {
            expect(vet([reported(riskFor(tier))], commented("OWNER")).findings[0]?.status).toBe("already-reported");
        });
    }

    test("anyone's comment settles a finding whose risk scores nothing, which is a nit", () => {
        expect(vet([reported(NO_RISK)], commented("NONE")).findings[0]?.status).toBe("already-reported");
    });

    for (const tier of UNLISTED_TIERS) {
        test(`anyone's comment still settles a ${tier} finding`, () => {
            expect(vet([reported(riskFor(tier))], commented("NONE")).findings[0]?.status).toBe("already-reported");
        });
    }
});

describe("vetSuppression: a listed finding citing no comment at all", () => {
    const raised = { findings: [{ file: "a.ts", title: "something low, worded otherwise" }] };

    for (const tier of LISTED_TIERS) {
        test(`a ${tier} finding is reopened, because the previous file record carries no rating`, () => {
            const out = vet([finding({ risk: riskFor(tier), status: "already-reported" })], {}, raised);

            expect(out.findings[0]?.status).toBe("new");
            expect(out.unvouched).toBe(1);
        });
    }

    test("a finding whose risk scores nothing rests on that file having been raised", () => {
        const out = vet([finding({ risk: NO_RISK, status: "already-reported" })], {}, raised);

        expect(out.findings[0]?.status).toBe("already-reported");
    });

    for (const tier of UNLISTED_TIERS) {
        test(`a ${tier} finding still rests on the previous review having raised that file`, () => {
            expect(
                vet([finding({ risk: riskFor(tier), status: "already-reported" })], {}, raised).findings[0]?.status,
            ).toBe("already-reported");
        });
    }
});
