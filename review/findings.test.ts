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

describe("vetDeclines", () => {
    const declined = (url?: string): Finding => finding({ status: "declined", existing_comment_url: url });

    function existing(association: string, resolved = false) {
        return {
            threads: [
                {
                    resolved,
                    url: "https://github.com/o/r/pull/1#discussion_r1",
                    comments: [
                        { association: "NONE", url: "https://github.com/o/r/pull/1#discussion_r1" },
                        { association, url: "https://github.com/o/r/pull/1#discussion_r2" },
                    ],
                },
            ],
        };
    }

    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
        test(`a reply from ${association} may decline`, () => {
            const out = vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r2")], existing(association));

            expect(out.reopened).toBe(0);
            expect(out.findings[0]?.status).toBe("declined");
        });
    }

    for (const association of ["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", ""]) {
        test(`a reply from ${association || "no association"} may not`, () => {
            const out = vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r2")], existing(association));

            expect(out.reopened).toBe(1);
            expect(out.findings[0]?.status).toBe("new");
        });
    }

    test("a resolved thread settles it whoever commented", () => {
        const out = vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r2")], existing("NONE", true));

        expect(out.reopened).toBe(0);
    });

    test("a decline citing no comment is reopened", () => {
        expect(vetDeclines([declined()], existing("OWNER")).reopened).toBe(1);
    });

    test("a decline citing a comment that is not there is reopened", () => {
        expect(vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r9")], existing("OWNER")).reopened).toBe(
            1,
        );
    });

    test("unreadable input reopens rather than accepts", () => {
        expect(vetDeclines([declined("https://github.com/o/r/pull/1#discussion_r2")], null).reopened).toBe(1);
    });

    test("a conversation comment is read the same way", () => {
        const url = "https://github.com/o/r/pull/1#issuecomment-1";
        const owner = { conversation: [{ association: "OWNER", url }] };
        const stranger = { conversation: [{ association: "NONE", url }] };

        expect(vetDeclines([declined(url)], owner).reopened).toBe(0);
        expect(vetDeclines([declined(url)], stranger).reopened).toBe(1);
    });

    test("it leaves every other status alone", () => {
        const out = vetDeclines([finding({ status: "new" }), finding({ status: "already-reported" })], {});

        expect(out.reopened).toBe(0);
        expect(out.findings.map((f) => f.status)).toEqual(["new", "already-reported"]);
    });
});
