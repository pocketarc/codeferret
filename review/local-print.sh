#!/usr/bin/env bash
# Print what the last local run found, for the session that started it.
#
# The third of the local-* scripts, and it exists for the same two reasons as the others:
# the run directory is derived here rather than pasted into a command by a model, and the
# `bun` it starts runs from the build directory. A checkout under review can carry a
# `bunfig.toml` whose `preload` bun runs first, and that tree is whatever branch is checked
# out. run.sh's `cd "$BUILD"` has the rest.
#
# Usage: local-print.sh <plugin-root>
set -euo pipefail

PLUGIN=${1:?usage: local-print.sh PLUGIN_ROOT}

GIT_DIR=$(git rev-parse --absolute-git-dir)
BUILD="$GIT_DIR/codeferret/run/build"
FINDINGS="$BUILD/findings.json"

if [ ! -f "$FINDINGS" ]; then
    echo "no findings at $FINDINGS. Run the review first." >&2
    exit 1
fi

cd "$BUILD"

exec bun "$PLUGIN/review/print-findings.ts" "$FINDINGS"
