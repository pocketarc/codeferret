#!/usr/bin/env bun
/**
 * Check merged findings against the shape post-review.ts reads.
 *
 * Only the action runs the orchestrator under `--json-schema`. Nothing enforces
 * merged-schema.json on a review driven from a Claude Code session, and post-review.ts
 * does not validate what it is handed: a finding with no `line` fails its anchor check
 * and ends up in the body, one with no `status` is posted as new, and one whose `file`
 * carries a leading slash matches nothing in the diff map. All three look like an
 * ordinary review.
 *
 * Usage: bun check-findings.ts <findings.json>
 */

const SEVERITIES = ["critical", "high", "medium", "low", "nit", "question"];
const STATUSES = ["new", "already-reported", "declined"];

const [path] = process.argv.slice(2);

if (!path) {
    console.error("usage: bun check-findings.ts <findings.json>");
    process.exit(2);
}

const problems: string[] = [];
const warnings: string[] = [];

function problem(where: string, message: string): void {
    problems.push(`${where}: ${message}`);
}

// A warning is something that is valid under the schema, and that post-review.ts
// survives. The check still prints it, but the action runs this under `bash -e`, so
// failing here would throw away a review that has already been paid for and post nothing.
function warn(where: string, message: string): void {
    warnings.push(`${where}: ${message}`);
}

function checkString(where: string, field: string, value: unknown, required = true): void {
    if (value === undefined) {
        if (required) problem(where, `missing \`${field}\``);
        return;
    }
    if (typeof value !== "string" || value.trim() === "") {
        problem(where, `\`${field}\` must be a non-empty string`);
    }
}

function checkInteger(where: string, field: string, value: unknown, required = true): void {
    if (value === undefined) {
        if (required) problem(where, `missing \`${field}\``);
        return;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        problem(where, `\`${field}\` must be a positive integer, got ${JSON.stringify(value)}`);
    }
}

function checkEnum(where: string, field: string, value: unknown, allowed: string[]): void {
    if (value === undefined) {
        problem(where, `missing \`${field}\``);
        return;
    }
    if (typeof value !== "string" || !allowed.includes(value)) {
        problem(where, `\`${field}\` must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
    }
}

let parsed: unknown;

try {
    parsed = JSON.parse(await Bun.file(path).text());
} catch (error) {
    console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

// `null` and `[]` both survive the parse above. Without this guard, `null` ends the run
// in a stack trace and `[]` ends it complaining that `findings` is missing, which sends
// the reader hunting for a field when the whole file is the wrong shape.
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`${path}: is ${Array.isArray(parsed) ? "an array" : String(parsed)}, not an object`);
    process.exit(1);
}

const merged = parsed as Record<string, unknown>;

checkString("findings.json", "summary", merged.summary, false);
checkString("findings.json", "notes", merged.notes, false);

if (!Array.isArray(merged.findings)) {
    console.error("findings.json: `findings` is missing or not an array");
    process.exit(1);
}

for (const [i, raw] of merged.findings.entries()) {
    const where = `finding ${i + 1}`;

    if (typeof raw !== "object" || raw === null) {
        problem(where, "is not an object");
        continue;
    }

    const f = raw as Record<string, unknown>;
    const label = typeof f.title === "string" ? `${where} (${f.title})` : where;

    checkString(label, "file", f.file);
    checkString(label, "category", f.category);
    checkString(label, "title", f.title);
    checkString(label, "body", f.body);
    checkInteger(label, "line", f.line);
    checkInteger(label, "end_line", f.end_line, false);
    checkEnum(label, "severity", f.severity, SEVERITIES);
    checkEnum(label, "status", f.status, STATUSES);

    // The diff map post-review.ts builds is keyed on the paths git prints, which never
    // carry a leading slash, so one that does matches nothing.
    if (typeof f.file === "string" && f.file.startsWith("/")) {
        problem(label, `\`file\` must be repo-relative, got '${f.file}'`);
    }

    // post-review.ts reads neither of these, so neither is worth losing a review over.
    if (!Array.isArray(f.found_by) || f.found_by.length === 0) {
        warn(label, "`found_by` names no lens");
    } else if (f.found_by.some((lens) => typeof lens !== "string")) {
        warn(label, "`found_by` holds something that is not a string");
    }

    if (f.in_diff !== undefined && typeof f.in_diff !== "boolean") {
        warn(label, "`in_diff` is not a boolean");
    }

    if ((f.status === "already-reported" || f.status === "declined") && !f.existing_comment_url) {
        warn(label, `is '${f.status}' but names no \`existing_comment_url\`, so it links nowhere`);
    }
}

if (merged.resolve !== undefined) {
    if (!Array.isArray(merged.resolve)) {
        problem("findings.json", "`resolve` is not an array");
    } else {
        for (const [i, raw] of merged.resolve.entries()) {
            const where = `resolve ${i + 1}`;
            if (typeof raw !== "object" || raw === null) {
                problem(where, "is not an object");
                continue;
            }
            const entry = raw as Record<string, unknown>;
            checkString(where, "thread_id", entry.thread_id);
            checkString(where, "reason", entry.reason);
        }
    }
}

if (merged.lens_health !== undefined) {
    if (!Array.isArray(merged.lens_health)) {
        problem("findings.json", "`lens_health` is not an array");
    } else {
        for (const [i, raw] of merged.lens_health.entries()) {
            const where = `lens_health ${i + 1}`;
            if (typeof raw !== "object" || raw === null) {
                problem(where, "is not an object");
                continue;
            }
            const entry = raw as Record<string, unknown>;
            checkString(where, "lens", entry.lens);
            checkString(where, "detail", entry.detail, false);

            if (typeof entry.findings_returned !== "number" || !Number.isInteger(entry.findings_returned)) {
                problem(where, "`findings_returned` must be an integer");
            }
            if (typeof entry.ok !== "boolean") {
                problem(where, "`ok` must be a boolean");
            }
        }
    }
}

for (const w of warnings) console.warn(`WARN ${w}`);

if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL ${p}`);
    console.error(`\n${problems.length} problem(s) in ${path}.`);
    process.exit(1);
}

const noted = warnings.length > 0 ? `, ${warnings.length} worth a look` : "";
console.log(`OK ${path}: ${merged.findings.length} finding(s), shape valid${noted}`);
