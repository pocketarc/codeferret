#!/usr/bin/env bash
set -euo pipefail

PLUGIN=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMMAND=${1:-run}
if [ "$#" -gt 0 ]; then shift; fi
export REVIEW_ENGINE=codex

case "$COMMAND" in
run)
    BASE=${1:-}
    if [ "$#" -gt 0 ]; then shift; fi
    exec bash "$PLUGIN/review/local-run.sh" "$PLUGIN" "$BASE" "$@"
    ;;
print)
    if [ "$#" -ne 0 ]; then
        echo "$COMMAND takes no arguments." >&2
        exit 2
    fi
    exec bash "$PLUGIN/review/local-$COMMAND.sh" "$PLUGIN"
    ;;
post)
    exec bash "$PLUGIN/review/local-post.sh" "$PLUGIN" "$@"
    ;;
preflight)
    exec bash "$PLUGIN/review/local-preflight.sh" "$@"
    ;;
*)
    echo "Usage: codex.sh run [BASE_REF] [LENS...] | print | post PR_NUMBER | preflight < BASE_REF_FILE" >&2
    exit 2
    ;;
esac
