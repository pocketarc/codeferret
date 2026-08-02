#!/usr/bin/env bash
# Run one review against this checkout, from a Claude Code session.
#
# /codeferret:review calls this. Everything the run needs is derived here rather than
# pasted into a command by a model: the git dir the run directory hangs off, the top
# level, the three defaults, and the gh credentials.
#
# Naming lenses drops the tools unless the tool-reading lens is among them, because the
# tools report to that lens and to nothing else.
#
# Usage: local-run.sh <plugin-root> <base-ref> [<lens>...]
#
# The base ref may be an empty string, and then it is worked out here the way
# local-preflight.sh reports it: the open pull request's base, then the default branch. Pass
# one only where the caller means a particular ref. git resolves a ref relayed through a
# model whether or not it is the right one, and the symptom is fourteen lenses reviewing the
# wrong range for twenty minutes.
#
# Env:
#   INCLUDE_WORKING_TREE  1 to review uncommitted work as well. Pass merge_base as the
#                         base ref with it.
#   MODEL                 defaults to opus.
#   EFFORT                reasoning effort: low, medium, high, xhigh or max. Empty leaves
#                         the model's own default.
set -euo pipefail

PLUGIN=${1:?usage: local-run.sh PLUGIN_ROOT BASE_REF [LENS...]}
BASE=${2?missing base ref (pass an empty string to work it out here)}
shift 2

TOPLEVEL=$(git rev-parse --show-toplevel)
GIT_DIR=$(git rev-parse --absolute-git-dir)

# shellcheck source=review/lib.sh
. "$PLUGIN/review/lib.sh"

# One `gh pr view` for both values. A closed or merged pull request the branch used to have
# would name a base nobody is working from now, so only an open one counts.
PR=""
PR_BASE=""

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    PR_LINE=$(gh pr view --json number,baseRefName,state \
        --jq 'select(.state == "OPEN") | [.number, .baseRefName] | @tsv' 2>/dev/null || true)
    PR=$(printf '%s' "$PR_LINE" | cut -f1)
    PR_BASE=$(printf '%s' "$PR_LINE" | cut -f2)
fi

if [ -z "$BASE" ] && [ -n "$PR_BASE" ]; then
    BASE="origin/$PR_BASE"
fi

if [ -z "$BASE" ]; then
    DEFAULT=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
    DEFAULT=${DEFAULT#origin/}

    if [ -z "$DEFAULT" ] && command -v gh >/dev/null 2>&1; then
        DEFAULT=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)
    fi

    if [ -n "$DEFAULT" ]; then
        BASE="origin/$DEFAULT"
    fi
fi

if [ -z "$BASE" ]; then
    echo "no base ref given, and this checkout has neither an open pull request nor an origin" >&2
    echo "default branch to take one from. Name a ref: /codeferret:review origin/main" >&2
    exit 1
fi

echo "reviewing against $BASE"

if [ "$#" -gt 0 ]; then
    LENSES=$(printf '%s\n' "$@")
    TOOLS=""

    if printf '%s\n' "$@" | grep -qx "$TOOLS_LENS"; then
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

# Without a pull request there is nothing to read earlier comments from, so every finding
# counts as new. That is a noisier review rather than a failed one, and run.sh warns.
if [ -n "$PR" ]; then
    export PR
    OWN_LOGIN=$(gh api user --jq .login 2>/dev/null || true)
    export OWN_LOGIN
    gh_credentials
fi

exec bash "$PLUGIN/review/run.sh" "$BASE" "$PLUGIN" "$GIT_DIR/codeferret/run" "$TOPLEVEL"
