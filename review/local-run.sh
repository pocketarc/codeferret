#!/usr/bin/env bash
# Run one review against this checkout, from a Claude Code session.
#
# /codeferret:review calls this. Everything the run needs is derived here rather than
# pasted into a command by a model: the git dir the run directory hangs off, the top
# level, the three defaults, and the gh credentials. build-prompts.sh grew a guard
# against deleting the wrong directory because that path used to arrive by substitution.
#
# Naming lenses drops the tools unless static-analysis is among them, because the tools
# report to that lens and to nothing else.
#
# Usage: local-run.sh <plugin-root> <base-ref> [<lens>...]
#
# Env:
#   INCLUDE_WORKING_TREE  1 to review uncommitted work as well. Pass merge_base as the
#                         base ref with it.
#   MODEL                 defaults to opus.
#   EFFORT                reasoning effort: low, medium, high, xhigh or max. Empty leaves
#                         the model's own default.
set -euo pipefail

PLUGIN=${1:?usage: local-run.sh PLUGIN_ROOT BASE_REF [LENS...]}
BASE=${2:?missing base ref}
shift 2

TOPLEVEL=$(git rev-parse --show-toplevel)
GIT_DIR=$(git rev-parse --absolute-git-dir)

if [ "$#" -gt 0 ]; then
    LENSES=$(printf '%s\n' "$@")
    TOOLS=""

    if printf '%s\n' "$@" | grep -qx static-analysis; then
        TOOLS=$(cat "$PLUGIN/review/defaults/tools.txt")
    fi
else
    LENSES=$(cat "$PLUGIN/review/defaults/lenses.txt")
    TOOLS=$(cat "$PLUGIN/review/defaults/tools.txt")
fi

EXCLUDE_PATHS=$(cat "$PLUGIN/review/defaults/exclude-paths.txt")

export LENSES TOOLS EXCLUDE_PATHS
export MODEL=${MODEL:-opus}

# Claude Code's permission classifier passes the reads a lens needs and refuses the rest.
# The action uses bypassPermissions because a runner is disposable and this machine is not.
export PERMISSION_MODE=auto

# Only CodeFerret's own account can tell its threads from a person's, and this run posts
# as whoever is at the keyboard.
export RESOLVE_THREADS=0

# Without gh there is nothing to read earlier comments from, so every finding counts as
# new. That is a noisier review rather than a failed one, and the run says so.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    PR=$(gh pr view --json number,state --jq 'select(.state == "OPEN") | .number' 2>/dev/null || true)

    if [ -n "$PR" ]; then
        export PR
        OWN_LOGIN=$(gh api user --jq .login 2>/dev/null || true)
        GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
        GITHUB_REPOSITORY=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
        export OWN_LOGIN GITHUB_TOKEN GITHUB_REPOSITORY
    fi
fi

exec bash "$PLUGIN/review/run.sh" "$BASE" "$PLUGIN" "$GIT_DIR/codeferret/run" "$TOPLEVEL"
