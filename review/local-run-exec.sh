#!/usr/bin/env bash
set -euo pipefail

PLUGIN=${1:?usage: local-run-exec.sh PLUGIN_ROOT BASE_REF RUN_DIR TOPLEVEL LOCK_DIR}
BASE=${2:?missing base ref}
RUN_DIR=${3:?missing run directory}
TOPLEVEL=${4:?missing workspace}
LOCK_DIR=${5:?missing lock directory}

trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if bash "$PLUGIN/review/run.sh" "$BASE" "$PLUGIN" "$RUN_DIR" "$TOPLEVEL"; then
    status=0
else
    status=$?
fi

exit "$status"
