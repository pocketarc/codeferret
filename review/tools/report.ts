/**
 * The shape every static analysis report is written in.
 *
 * The `static-analysis` lens is asked to account for what each report held and whether
 * the tool ran at all, and it cannot do that from a shape that changes with the path the
 * tool took. Two hand-written object literals kept that contract until a type did: a
 * misspelled key produced a report the lens read as a clean result.
 */
export interface ToolReport {
    tool: string;
    /** False means nothing was scanned, whatever else the report says. `reason` says why. */
    ran: boolean;
    /** How the tool was run: a binary on PATH, or a digest-pinned container. */
    how: string | null;
    reason: string | null;
    /** What the tool analysed. Each tool decides its own scope. */
    scanned: number;
    /** Everything the tool raised, before the cap below. */
    raised: number;
    /** How many of those did not fit. The report is sorted so these are the low end. */
    truncated: number;
    findings: Array<Record<string, unknown>>;
    [key: string]: unknown;
}

/**
 * A writer bound to one tool's output file, spreading each partial report over the same
 * defaults so that every exit writes every key.
 */
export function reporter(
    tool: string,
    out: string,
    extra: Record<string, unknown> = {},
): (report: Partial<ToolReport> & Record<string, unknown>) => Promise<void> {
    const defaults: ToolReport = {
        tool,
        ran: false,
        how: null,
        reason: null,
        scanned: 0,
        raised: 0,
        truncated: 0,
        findings: [],
        ...extra,
    };

    return async (report) => {
        await Bun.write(out, `${JSON.stringify({ ...defaults, ...report }, null, 2)}\n`);
    };
}

/** The repository root, because git prints paths relative to it and a finding anchors on one. */
export function repoRoot(): string {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
    return new TextDecoder().decode(proc.stdout).trim() || process.cwd();
}
