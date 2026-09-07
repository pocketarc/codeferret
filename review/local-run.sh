#!/usr/bin/env bash
# Usage: local-run.sh <plugin-root> <base-ref> [<lens>...]
#
# The base ref may be an empty string, and then it is worked out here the way
# local-preflight.sh reports it: the open pull request's base, then the default branch. Pass
# one only where the caller means a particular ref. git resolves a ref relayed through a
# model whether or not it is the right one, and the symptom is every lens reviewing the
# wrong range for twenty minutes.
#
# Env:
#   INCLUDE_WORKING_TREE  1 to review uncommitted work as well. Pass merge_base as the
#                         base ref with it.
#   MODEL                 Claude default: opus. Codex default: the CLI default.
#   EFFORT                low, medium, high or xhigh. Claude also accepts max.
#                         Leave empty to use the model's default.
set -euo pipefail

PLUGIN=${1:?usage: local-run.sh PLUGIN_ROOT BASE_REF [LENS...]}
# `?` and not `:?`: an empty string is a base ref the caller wants worked out here, and only
# an unset second argument means the caller forgot one.
BASE=${2?missing base ref (pass an empty string to work it out here)}
shift 2

TOPLEVEL=$(git rev-parse --show-toplevel)

# shellcheck source=review/lib.sh
. "$PLUGIN/review/lib.sh"

RUN_ROOT=$(session_run_dir)
LOCK_DIR="${RUN_ROOT}.lock"
mkdir -p "$(dirname "$RUN_ROOT")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    exit 1
fi

trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT
run_dirs "$RUN_ROOT"

open_pr
BASE=$(resolve_base "$BASE")

if [ -z "$BASE" ]; then
    echo "No base ref was supplied, and CodeFerret could not resolve a base from a pull request or origin." >&2
    echo "Pass a base ref, such as origin/main, to the local review command." >&2
    exit 1
fi

echo "reviewing against $BASE"

if [ "$#" -gt 0 ]; then
    LENSES=$(printf '%s\n' "$@")
else
    LENSES=$(cat "$PLUGIN/review/defaults/lenses.txt")
fi

EXCLUDE_PATHS=$(cat "$PLUGIN/review/defaults/exclude-paths.txt")

export LENSES EXCLUDE_PATHS
if [ "${REVIEW_ENGINE:-claude}" = codex ]; then
    if ! CODEX_LOGIN=$(codex login status 2>&1); then
        printf '%s\n' "$CODEX_LOGIN" >&2
        exit 1
    fi
    case "$CODEX_LOGIN" in
    *"Logged in using ChatGPT"*) ;;
    *)
        echo "Local Codex reviews require a ChatGPT login. Run codex login and choose ChatGPT." >&2
        exit 1
        ;;
    esac
    export MODEL=${MODEL:-}
else
    export MODEL=${MODEL:-opus}
fi

export PERMISSION_MODE=auto

# Only CodeFerret's own account can tell its threads from a person's, and this run posts
# as whoever is at the keyboard.
export RESOLVE_THREADS=0

# Without a pull request there is nothing to read earlier comments from, so every finding
# counts as new. That is a noisier review rather than a failed one, and run.sh warns.
if [ -n "$PR" ]; then
    OWN_LOGIN=$(own_login)
    export OWN_LOGIN
    gh_credentials

    # run.sh must not be started with the token in its environment, and here it is somebody's
    # own `gh` credential rather than a disposable runner's. "The GitHub token never enters
    # the step that runs the agent" in review/DECISIONS.md has why an unset would not do.
    GITHUB_TOKEN_FILE=$(token_file "$RUN_DIR")
    export GITHUB_TOKEN_FILE

    printf '%s' "$GITHUB_TOKEN" | stage_token "$RUN_DIR"
fi

# Outside the branch above, because the reason holds whether or not this run staged a
# credential. A developer with GITHUB_TOKEN or GH_TOKEN exported in their own shell hands it
# to every process they start, and on a branch with no pull request nothing above runs, so
# the value reached the environment run.sh was execve'd with and stayed readable in /proc for
# the length of the review. Dropping them here covers both, and costs nothing when neither
# was set: run.sh takes the token it needs from the file named above.
unset -v GITHUB_TOKEN GH_TOKEN

if bash "$PLUGIN/review/run.sh" "$BASE" "$PLUGIN" "$RUN_DIR" "$TOPLEVEL"; then
    status=0
else
    status=$?
fi

exit "$status"
