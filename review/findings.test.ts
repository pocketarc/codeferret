import { describe, expect, test } from "bun:test";
import { isListed, lenses, partition, vetDeclines } from "./findings.ts";
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

describe("lenses", () => {
    test("counts one lens as one lens", () => {
        expect(lenses(1)).toBe("1 lens");
        expect(lenses(0)).toBe("0 lenses");
        expect(lenses(14)).toBe("14 lenses");
    });
});

describe("vetDeclines: who may settle a finding", () => {
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
            const out = vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r2")], existing(association));

            expect([out.untraceable, out.unrelated]).toEqual([0, 0]);
            expect(out.findings[0]?.status).toBe("declined");
        });
    }

    for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", ""]) {
        test(`a reply from ${association || "no association"} may not`, () => {
            const out = vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r2")], existing(association));

            expect(out.untraceable).toBe(1);
            expect(out.findings[0]?.status).toBe("new");
        });
    }

    test("a resolved thread settles it whoever commented", () => {
        const out = vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r2")], existing("NONE", true));

        expect(out.untraceable).toBe(0);
    });

    test("a decline citing no comment is reopened", () => {
        expect(vetDeclines([declined()], existing("OWNER")).untraceable).toBe(1);
    });

    test("a decline citing a comment that is not there is reopened", () => {
        const out = vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r9")], existing("OWNER"));

        expect(out.untraceable).toBe(1);
    });

    test("unreadable input reopens rather than accepts", () => {
        const out = vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r2")], null);

        expect(out.untraceable).toBe(1);
    });

    test("it leaves every other status alone", () => {
        const out = vetDeclines([finding({ status: "new" }), finding({ status: "already-reported" })], {});

        expect([out.untraceable, out.unrelated]).toEqual([0, 0]);
        expect(out.findings.map((f) => f.status)).toEqual(["new", "already-reported"]);
    });
});

describe("vetDeclines: whether the comment is about the finding", () => {
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
        expect(vetDeclines([declined("src/a.ts", url)], thread("src/a.ts")).unrelated).toBe(0);
    });

    test("a reply on a thread about another file does not", () => {
        const out = vetDeclines([declined("src/a.ts", url)], thread("src/b.ts"));

        expect([out.untraceable, out.unrelated]).toEqual([0, 1]);
        expect(out.findings[0]?.status).toBe("new");
    });

    test("a reply about another file still settles a finding it names", () => {
        expect(vetDeclines([declined("src/a.ts", url)], thread("src/b.ts", "src/a.ts is meant to be")).unrelated).toBe(
            0,
        );
    });

    test("an unrelated conversation comment from an owner settles nothing", () => {
        const lgtm = { conversation: [{ association: "OWNER", url: conversationUrl, body: "LGTM, merging" }] };
        const out = vetDeclines([declined("src/a.ts", conversationUrl)], lgtm);

        expect([out.untraceable, out.unrelated]).toEqual([0, 1]);
    });

    test("a conversation comment naming the file does settle it", () => {
        const named = {
            conversation: [{ association: "OWNER", url: conversationUrl, body: "the float in `money.ts` is deliberate" }],
        };

        expect(vetDeclines([declined("src/money.ts", conversationUrl)], named).unrelated).toBe(0);
    });

    test("a stranger naming the file settles nothing either", () => {
        const named = {
            conversation: [{ association: "NONE", url: conversationUrl, body: "src/a.ts is fine" }],
        };

        expect(vetDeclines([declined("src/a.ts", conversationUrl)], named).untraceable).toBe(1);
    });
});
