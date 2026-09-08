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

RUN_ROOT=$(session_run_dir)
mkdir -p "$(dirname "$RUN_ROOT")"
LOCK_DIR="${RUN_ROOT}.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    exit 1
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
run_dirs "$RUN_ROOT"
BUILD=$BUILD_DIR
FINDINGS="$BUILD/findings.json"

require_checked_findings "$BUILD" "$PLUGIN" print || exit 1

# What the review already said decides which of these findings are printed as new, so this
# path reads the pull request back for itself. run.sh leaves the file empty on purpose;
# lib.sh has why the fetch is here rather than there. Without gh there is no token, and then
# every suppression stays reopened and the print is noisier rather than absent.
open_pr
gh_credentials

if [ -n "$PR" ] && [ -n "$GITHUB_TOKEN" ] && [ -n "$GITHUB_REPOSITORY" ]; then
    printf '%s' "$GITHUB_TOKEN" | fetch_existing "$PLUGIN" "$BUILD" "$PR" "$(own_login)"
fi

cd "$BUILD"

# print-findings.ts makes no request, and the fetch above took its credential on stdin, so
# nothing past this line needs one. local-run.sh drops the same two names before its own exec
# and gives the reason.
unset -v GITHUB_TOKEN GH_TOKEN

exec bun --config=/dev/null "$PLUGIN/review/print-findings.ts" "$FINDINGS"
