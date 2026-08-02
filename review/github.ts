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

    return { owner, name };
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
 * The two callers want different things from it: one treats any error as fatal, the other
 * reads the message to tell a missing permission from a bad thread id. So neither the
 * status nor the errors are decided here.
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

    const payload = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };

    return { ok: response.ok, status: response.status, data: payload.data, errors: payload.errors };
}

export function graphqlFailure(result: GraphqlResult): string | null {
    if (result.errors && result.errors.length > 0) {
        return result.errors.map((e) => e.message).join("; ");
    }

    return result.ok ? null : `HTTP ${result.status}`;
}
