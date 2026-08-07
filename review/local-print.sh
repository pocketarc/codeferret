#!/usr/bin/env bash
# Print what the last local run found, for the session that started it.
#
# The run directory is derived here rather than pasted into a command by a model, and the
# `bun` it starts is kept away from the `bunfig.toml` a checkout under review may hold.
# run.sh's `cd "$BUILD"` is there for the same reason.
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

cd "$BUILD"

exec bun --config=/dev/null "$PLUGIN/review/print-findings.ts" "$FINDINGS"
