import { integer, record, string } from "./json.ts";

export function plainName(value: string): boolean {
    return value !== "" && !value.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(value);
}

export function validLensName(value: string): boolean {
    const separator = value.indexOf(":");

    return separator > 0 && separator === value.lastIndexOf(":") &&
        plainName(value.slice(0, separator)) && plainName(value.slice(separator + 1));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\[\]\\]/g, "\\$&");
}

export function renderTemplate(template: string, replacements: Readonly<Record<string, string>>): string {
    const keys = Object.keys(replacements);
    const known = new Set(keys);
    const markers = [...template.matchAll(/__[A-Z_]+__/g)].map((match) => match[0]);
    const unknown = [...new Set(markers.filter((marker) => !known.has(marker)))];
    if (unknown.length > 0) throw new Error(`The prompt has unfilled placeholders: ${unknown.join(", ")}`);

    const seen = new Set<string>();
    const pattern = keys.length > 0 ? new RegExp(keys.map(escapeRegExp).join("|"), "g") : null;
    const rendered = pattern
        ? template.replace(pattern, (placeholder) => {
              if (seen.has(placeholder)) throw new Error(`The prompt must contain ${placeholder} exactly once.`);
              seen.add(placeholder);
              return replacements[placeholder] ?? "";
          })
        : template;
    const missing = keys.filter((key) => !seen.has(key));
    if (missing.length > 0) throw new Error(`The prompt must contain ${missing[0]} exactly once.`);

    return rendered;
}

export function strictSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(strictSchema);
    const node = record(value);
    if (!node) return value;

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) result[key] = strictSchema(child);
    const properties = record(node.properties);
    if (node.type === "object" && properties) {
        const required = Array.isArray(node.required) ? node.required : [];
        result.properties = Object.fromEntries(
            Object.entries(properties).map(([key, child]) => [
                key,
                required.includes(key) ? strictSchema(child) : { anyOf: [strictSchema(child), { type: "null" }] },
            ]),
        );
        result.required = Object.keys(properties);
        result.additionalProperties = false;
    }
    return result;
}

export function withoutNullProperties(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutNullProperties);
    const object = record(value);
    if (!object) return value;
    return Object.fromEntries(
        Object.entries(object)
            .filter(([, child]) => child !== null)
            .map(([key, child]) => [key, withoutNullProperties(child)]),
    );
}

export interface CodexResult {
    output: Record<string, unknown> | null;
    outputTokens: number | null;
    error: string | null;
}

export function codexResult(log: string, exitCode: number): CodexResult {
    let message: string | null = null;
    let outputTokens: number | null = null;
    let started = 0;
    let completed = 0;
    let error: string | null = exitCode === 0 ? null : `Codex exited with status ${exitCode}.`;
    let terminal = false;

    for (const line of log.split("\n")) {
        if (line.trim() === "") continue;
        let event: Record<string, unknown> | null;
        try {
            event = record(JSON.parse(line));
        } catch {
            error = "The Codex event log contains an incomplete or invalid JSON line.";
            continue;
        }
        if (!event) {
            error = "The Codex event log contains a non-object event.";
            continue;
        }
        if (terminal) error = "The Codex event log contains events after its terminal event.";
        if (event.type === "turn.started") started += 1;
        if (event.type === "turn.completed") {
            completed += 1;
            terminal = true;
            const tokens = integer(record(event.usage)?.output_tokens);
            outputTokens = tokens !== null && tokens >= 0 ? tokens : null;
        }
        if (event.type === "turn.failed" || event.type === "error") {
            error = string(record(event.error)?.message) ?? string(event.message) ?? "The Codex turn failed.";
        }
        const item = record(event.item);
        if (event.type === "item.completed" && item?.type === "agent_message") message = string(item.text);
    }

    if (started !== 1 || completed !== 1) error ??= "Codex did not complete exactly one turn.";
    if (error) return { output: null, outputTokens, error };

    try {
        const output = record(withoutNullProperties(JSON.parse(message ?? "")));
        if (!output || !Array.isArray(output.findings)) throw new Error("missing findings");
        return { output, outputTokens, error: null };
    } catch {
        return { output: null, outputTokens, error: "Codex returned no JSON object with a findings array." };
    }
}

export function codexArgs(cwd: string, schema: string, model: string, effort: string): string[] {
    const config = [
        'approval_policy="never"',
        "project_doc_max_bytes=0",
        'web_search="disabled"',
        "agents.enabled=false",
        "analytics.enabled=false",
        "feedback.enabled=false",
        "memories.generate_memories=false",
        "memories.use_memories=false",
        "shell_environment_policy.ignore_default_excludes=false",
        "shell_environment_policy.experimental_use_profile=false",
    ];
    if (effort) config.push(`model_reasoning_effort=${JSON.stringify(effort)}`);
    return [
        "codex", "exec", "--ignore-user-config", "--ignore-rules", "--strict-config",
        "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--cd", cwd,
        "--json", "--color", "never", "--output-schema", schema,
        ...["hooks", "plugins", "apps", "memories", "browser_use", "computer_use", "image_generation", "artifact"]
            .flatMap((feature) => ["--disable", feature]),
        ...config.flatMap((setting) => ["-c", setting]),
        ...(model ? ["--model", model] : []),
        "-",
    ];
}

export function positiveSetting(name: string, fallback: number, maximum: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
    }
    return value;
}

export async function concurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const queue = items.entries();
    const results = new Map<number, R>();
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (const [index, item] of queue) results.set(index, await fn(item));
    }));
    return [...results].sort(([a], [b]) => a - b).map(([, result]) => result);
}
