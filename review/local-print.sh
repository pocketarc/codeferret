#!/usr/bin/env bash
# Print what the last local run found, for the session that started it.
#
# The run directory is derived here rather than pasted into a command by a model, and the
# `bun` it starts is kept away from the `bunfig.toml` a checkout under review may hold.
# run.sh's `cd "$BUILD"` is there for the same reason.
#
# Printing is held to the checks posting is held to, because both read the same findings
# through the same modules.
#
# Usage: local-print.sh <plugin-root>
set -euo pipefail

PLUGIN=${1:?usage: local-print.sh PLUGIN_ROOT}

# shellcheck source=review/lib.sh
. "$PLUGIN/review/lib.sh"

run_dirs "$(session_run_dir)"
BUILD=$BUILD_DIR
FINDINGS="$BUILD/findings.json"

if [ ! -f "$FINDINGS" ]; then
    echo "no findings at $FINDINGS. Run the review first." >&2
    exit 1
fi

# The same gate local-post.sh puts in front of posting, because printing reaches the same
# fields. `readMerged` checks that `findings` is an array and nothing more, and
# print-findings.ts then calls `.localeCompare` on a finding's file and `.replace` on a lens
# name, both of which check-findings.ts repairs and neither of which anything else narrows. A
# `lens_health` entry naming its lens as a number ends a run that cost real money in a
# TypeError. The gate for this path used to be a step of commands/review.md, and prose is not
# a boundary.
if [ ! -f "$BUILD/findings-checked" ]; then
    echo "$FINDINGS did not pass check-findings.ts, so there is nothing safe to print." >&2
    # With the flag, like every other bun a run starts. Whoever reads this line is standing
    # in the checkout under review, which is the directory bun takes a `bunfig.toml` from.
    echo "run: bun --config=/dev/null '$PLUGIN/review/check-findings.ts' '$FINDINGS'" >&2
    exit 1
fi

# What the review already said decides which of these findings are printed as new, so this
# path reads the pull request back for itself. run.sh leaves the file empty on purpose;
# lib.sh has why the fetch is here rather than there. Without gh there is no token, and then
# every suppression stays reopened and the print is noisier rather than absent.
open_pr
gh_credentials

if [ -n "$PR" ] && [ -n "$GITHUB_TOKEN" ] && [ -n "$GITHUB_REPOSITORY" ]; then
    printf '%s' "$GITHUB_TOKEN" | fetch_existing "$PLUGIN" "$BUILD" "$PR"
fi

cd "$BUILD"

exec bun --config=/dev/null "$PLUGIN/review/print-findings.ts" "$FINDINGS"
