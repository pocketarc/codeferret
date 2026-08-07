/**
 * How a run's scripts talk to GitHub: the token handshake, the request headers, and the
 * shape of a failure.
 */

/** The token. run.sh pipes it in; the environment variable is for running a script by hand. */
export async function tokenFromStdinOrEnv(): Promise<string> {
    const fromEnvironment = process.env.GITHUB_TOKEN;

    if (fromEnvironment) return fromEnvironment;

    return process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
}

/**
 * GitHub's grammar for an owner or a repository name.
 *
 * The same bar `requirePullNumber` holds its value to, and for the same reason: the whole
 * string is interpolated into REST paths, each with a bearer token attached. `fetch`
 * normalises dot segments before the request goes out, so `../x` as the owner took
 * `/repos/../x/actions/artifacts` to `/x/actions/artifacts`, and a `?` or a `#` would turn
 * the rest of the path into a query string or a fragment instead.
 */
const REPOSITORY_PART = /^[A-Za-z0-9._-]+$/;

/**
 * `GITHUB_REPOSITORY` split, or null when it is not `owner/name`.
 *
 * Checked rather than left to whatever reads it: the halves become GraphQL variables,
 * where an undefined one comes back as a coercion error naming `$name` and tells the
 * reader nothing about the environment variable that is wrong.
 */
export function splitRepository(repo: string | undefined): { owner: string; name: string } | null {
    const parts = (repo ?? "").split("/");
    const [owner, name] = parts;

    if (parts.length !== 2 || !owner || !name) return null;
    if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) return null;

    // Legal under the pattern above and still a path segment rather than a name.
    if ([owner, name].some((part) => part === "." || part === "..")) return null;

    return { owner, name };
}

/** `GITHUB_REPOSITORY` split, or the script ends. */
export function requireRepository(repo: string | undefined): { owner: string; name: string } {
    const split = splitRepository(repo);

    if (!split) {
        console.error(`GITHUB_REPOSITORY is '${repo}'. It has to be owner/name.`);
        process.exit(2);
    }

    return split;
}

/**
 * A pull request number, or the script ends.
 *
 * The value reaches a REST path and a GraphQL variable, and it arrives from a workflow
 * input or from a model pasting the preflight's `pr=` line. A `/` or a `..` re-points the
 * request at another resource, and a `?` hangs a query string off it.
 */
export function requirePullNumber(value: string | undefined): string {
    if (!value || !/^[0-9]+$/.test(value)) {
        console.error(`pr-number is '${value}'. It has to be a number.`);
        process.exit(2);
    }

    return value;
}

const API = "https://api.github.com";

export function rest(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...init.headers,
        },
    });
}

export async function restJson(token: string, path: string): Promise<unknown> {
    const response = await rest(token, path);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} on ${path}: ${(await response.text()).slice(0, 200)}`);
    }

    return response.json();
}

export interface GraphqlResult {
    ok: boolean;
    status: number;
    data?: unknown;
    errors?: Array<{ message: string }>;
}

/**
 * A GraphQL request, returning the payload whole.
 *
 * Callers want different things from it: one treats any error as fatal, another reads the
 * message to tell a missing permission from a bad thread id. So neither the status nor the
 * errors are decided here.
 *
 * A body that is not JSON comes back as an error rather than a rejection. GitHub answers a
 * 502 or a gateway timeout with HTML, and post-review.ts resolves threads at the top level
 * before it posts: a throw there ends the process with a review that is written, paid for
 * and unposted, over a thread nobody needed closed.
 */
export async function graphql(
    token: string,
    query: string,
    variables: Record<string, unknown>,
): Promise<GraphqlResult> {
    const response = await fetch(`${API}/graphql`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
    });

    const body = await response.text();
    let payload: { data?: unknown; errors?: Array<{ message: string }> };

    try {
        payload = JSON.parse(body);
    } catch {
        return {
            ok: false,
            status: response.status,
            errors: [{ message: `HTTP ${response.status}, and the body was not JSON: ${body.slice(0, 200)}` }],
        };
    }

    return { ok: response.ok, status: response.status, data: payload.data, errors: payload.errors };
}

export function graphqlFailure(result: GraphqlResult): string | null {
    if (result.errors && result.errors.length > 0) {
        return result.errors.map((e) => e.message).join("; ");
    }

    return result.ok ? null : `HTTP ${result.status}`;
}
