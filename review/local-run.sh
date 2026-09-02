#!/usr/bin/env bash
# Run one review against this checkout, from a Claude Code session.
#
# /codeferret:review calls this. Everything the run needs is derived here rather than
# pasted into a command by a model: the git dir the run directory hangs off, the top
# level, the three defaults, and the gh credentials.
#
#
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
#   MODEL                 defaults to opus.
#   EFFORT                reasoning effort: low, medium, high, xhigh or max. Empty leaves
#                         the model's own default.
set -euo pipefail

PLUGIN=${1:?usage: local-run.sh PLUGIN_ROOT BASE_REF [LENS...]}
# `?` and not `:?`: an empty string is a base ref the caller wants worked out here, and only
# an unset second argument means the caller forgot one.
BASE=${2?missing base ref (pass an empty string to work it out here)}
shift 2

TOPLEVEL=$(git rev-parse --show-toplevel)

# shellcheck source=review/lib.sh
. "$PLUGIN/review/lib.sh"

run_dirs "$(session_run_dir)"

open_pr
BASE=$(resolve_base "$BASE")

if [ -z "$BASE" ]; then
    echo "no base ref given, and this checkout has neither an open pull request nor an origin" >&2
    echo "default branch to take one from. Name a ref: /codeferret:review origin/main" >&2
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

exec bash "$PLUGIN/review/run.sh" "$BASE" "$PLUGIN" "$RUN_DIR" "$TOPLEVEL"
