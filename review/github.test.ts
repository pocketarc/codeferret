import { afterEach, describe, expect, test } from "bun:test";
import { graphql, graphqlFailure } from "./github.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function answerWith(answer: () => Promise<Response>): void {
    globalThis.fetch = Object.assign(answer, { preconnect: realFetch.preconnect.bind(realFetch) });
}

describe("graphql", () => {
    test("reports a request that never completed, rather than rejecting", async () => {
        answerWith(() => Promise.reject(new Error("socket hang up")));

        const result = await graphql("token", "query { viewer { login } }", {});

        expect(result.ok).toBe(false);
        expect(graphqlFailure(result)).toContain("socket hang up");
    });

    test("reports a body that is not JSON, which is what a gateway answers with", async () => {
        answerWith(() => Promise.resolve(new Response("<html>502</html>", { status: 502 })));

        const result = await graphql("token", "query { viewer { login } }", {});

        expect(result.ok).toBe(false);
        expect(result.status).toBe(502);
        expect(graphqlFailure(result)).toContain("the body was not JSON");
    });

    test("hands back the payload whole, so each caller decides what an error means", async () => {
        const payload = { data: { viewer: null }, errors: [{ message: "Resource not accessible" }] };

        answerWith(() => Promise.resolve(Response.json(payload)));

        const result = await graphql("token", "query { viewer { login } }", {});

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ viewer: null });
        expect(graphqlFailure(result)).toBe("Resource not accessible");
    });
});
