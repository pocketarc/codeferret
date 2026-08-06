import { describe, expect, test } from "bun:test";
import { isListed, partition, vetSuppression } from "./findings.ts";
import type { Finding } from "./findings.ts";

function finding(over: Partial<Finding> = {}): Finding {
    return {
        file: "a.ts",
        line: 1,
        severity: "low",
        category: "style",
        title: "A title",
        body: "A body.",
        ...over,
    };
}

describe("partition", () => {
    test("splits on status and orders by severity", () => {
        const { all, fresh, suppressed, declined } = partition([
            finding({ title: "low", severity: "low" }),
            finding({ title: "seen", status: "already-reported" }),
            finding({ title: "crit", severity: "critical" }),
            finding({ title: "no", status: "declined" }),
        ]);

        expect(all.map((f) => f.title)).toEqual(["crit", "low", "seen", "no"]);
        expect(fresh.map((f) => f.title)).toEqual(["crit", "low"]);
        expect(suppressed.map((f) => f.title)).toEqual(["seen"]);
        expect(declined.map((f) => f.title)).toEqual(["no"]);
    });
});

describe("isListed", () => {
    test("lists the two severities that decide whether to stop and look", () => {
        expect(isListed(finding({ severity: "critical" }))).toBe(true);
        expect(isListed(finding({ severity: "high" }))).toBe(true);
        expect(isListed(finding({ severity: "medium" }))).toBe(false);
    });

    test("lists a label nothing recognises rather than leaving it out", () => {
        expect(isListed(finding({ severity: "Critical" }))).toBe(true);
    });
});

describe("vetSuppression: who may settle a finding", () => {
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

    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
        test(`a reply from ${association} may decline`, () => {
            const out = vetSuppression([declined("https://github.com/o/r/pull/1#discussion_r2")], existing(association));

            expect([out.untraceable, out.unrelated]).toEqual([0, 0]);
            expect(out.findings[0]?.status).toBe("declined");
        });
    }

    for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", ""]) {
        test(`a reply from ${association || "no association"} may not`, () => {
            const out = vetSuppression([declined("https://github.com/o/r/pull/1#discussion_r2")], existing(association));

            expect(out.untraceable).toBe(1);
            expect(out.findings[0]?.status).toBe("new");
        });
    }

    test("a reply on a resolved thread settles a finding in that thread's own file", () => {
        const out = vetSuppression([declined("https://github.com/o/r/pull/1#discussion_r2")], existing("NONE", true));

        expect([out.untraceable, out.unrelated]).toEqual([0, 0]);
        expect(out.findings[0]?.status).toBe("declined");
    });

    test("that reply settles nothing in another file, whatever it names", () => {
        const anyone = existing("NONE", true);
        const comment = anyone.threads[0]?.comments[1];

        if (comment) comment.body = "src/elsewhere.ts is meant to be like that";

        const out = vetSuppression(
            [finding({ file: "src/elsewhere.ts", status: "declined", existing_comment_url: comment?.url })],
            anyone,
        );

        expect(out.unrelated).toBe(1);
        expect(out.findings[0]?.status).toBe("new");
    });

    test("a decline citing no comment is reopened", () => {
        expect(vetSuppression([declined()], existing("OWNER")).untraceable).toBe(1);
    });

    test("a decline citing a comment that is not there is reopened", () => {
        const out = vetSuppression([declined("https://github.com/o/r/pull/1#discussion_r9")], existing("OWNER"));

        expect(out.untraceable).toBe(1);
    });

    test("unreadable input reopens rather than accepts", () => {
        const out = vetSuppression([declined("https://github.com/o/r/pull/1#discussion_r2")], null);

        expect(out.untraceable).toBe(1);
    });

    test("it leaves a new finding alone, and an already-reported one citing nothing", () => {
        const out = vetSuppression([finding({ status: "new" }), finding({ status: "already-reported" })], {});

        expect([out.untraceable, out.unrelated, out.unreported]).toEqual([0, 0, 0]);
        expect(out.findings.map((f) => f.status)).toEqual(["new", "already-reported"]);
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
        const out = vetSuppression([seen("src/a.ts", conversationUrl)], said("src/a.ts has this already"));

        expect(out.unreported).toBe(0);
        expect(out.findings[0]?.status).toBe("already-reported");
    });

    test("an LGTM naming no file does not, and it would have settled every finding", () => {
        const out = vetSuppression([seen("src/a.ts", conversationUrl)], said("LGTM, merging"));

        expect(out.unreported).toBe(1);
        expect(out.findings[0]?.status).toBe("new");
    });

    test("a url no comment on the pull request carries does not", () => {
        const out = vetSuppression([seen("src/a.ts", "https://evil.test/x")], said("src/a.ts has this already"));

        expect(out.unreported).toBe(1);
    });
});

describe("vetSuppression: naming a file by its basename", () => {
    const url = "https://github.com/o/r/pull/1#issuecomment-1";

    const said = (body: string) => ({ conversation: [{ association: "OWNER", url, body }] });

    const declined = (file: string): Finding => finding({ file, status: "declined", existing_comment_url: url });

    test("a basename in ordinary prose settles the file it names", () => {
        expect(vetSuppression([declined("src/money.ts")], said("money.ts is deliberate")).unrelated).toBe(0);
    });

    test("a basename inside a longer word does not", () => {
        expect(vetSuppression([declined("src/money.ts")], said("see money.ts.bak")).unrelated).toBe(1);
        expect(vetSuppression([declined("src/cache")], said("the cached value is fine")).unrelated).toBe(1);
    });

    test("a basename too short to be more than prose needs the whole path", () => {
        expect(vetSuppression([declined("cmd/id")], said("the id is meant to be like that")).unrelated).toBe(1);
        expect(vetSuppression([declined("cmd/id")], said("cmd/id is meant to be like that")).unrelated).toBe(0);
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
        expect(vetSuppression([declined("src/a.ts", url)], thread("src/a.ts")).unrelated).toBe(0);
    });

    test("a reply on a thread about another file does not", () => {
        const out = vetSuppression([declined("src/a.ts", url)], thread("src/b.ts"));

        expect([out.untraceable, out.unrelated]).toEqual([0, 1]);
        expect(out.findings[0]?.status).toBe("new");
    });

    test("a reply about another file still settles a finding it names", () => {
        expect(vetSuppression([declined("src/a.ts", url)], thread("src/b.ts", "src/a.ts is meant to be")).unrelated).toBe(
            0,
        );
    });

    test("an unrelated conversation comment from an owner settles nothing", () => {
        const lgtm = { conversation: [{ association: "OWNER", url: conversationUrl, body: "LGTM, merging" }] };
        const out = vetSuppression([declined("src/a.ts", conversationUrl)], lgtm);

        expect([out.untraceable, out.unrelated]).toEqual([0, 1]);
    });

    test("a conversation comment naming the file does settle it", () => {
        const named = {
            conversation: [{ association: "OWNER", url: conversationUrl, body: "the float in `money.ts` is deliberate" }],
        };

        expect(vetSuppression([declined("src/money.ts", conversationUrl)], named).unrelated).toBe(0);
    });

    test("a stranger naming the file settles nothing either", () => {
        const named = {
            conversation: [{ association: "NONE", url: conversationUrl, body: "src/a.ts is fine" }],
        };

        expect(vetSuppression([declined("src/a.ts", conversationUrl)], named).untraceable).toBe(1);
    });
});
