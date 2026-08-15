/**
 * A newline-separated value, as the trimmed lines every reader of one has to arrive at.
 *
 * `lenses`, `exclude-lenses` and `exclude-paths` all arrive as one string with a name per
 * line, and each is written in a workflow file where a YAML block scalar leaves the
 * indentation on and a blank line between entries is ordinary formatting. So every reader of
 * one has to split, trim and drop the blanks, and the run is wrong when two of them disagree:
 * if `build-prompts.sh` read its lens list one way and the subtraction in `select-lenses.ts`
 * read the same list another, an indented name trimmed on one side and not the other would be
 * an exclusion reported as matching nothing while the lens ran.
 *
 * `trim_lines` in review/lib.sh does the same for the shell, deliberately in the same three
 * steps: `String.prototype.trim` and `[[:space:]]` agree on the space, the tab and the
 * carriage return, which is the whole of what turns up here.
 */
export function lines(value: unknown): string[] {
    return String(value ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}
