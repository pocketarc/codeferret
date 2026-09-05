#!/usr/bin/env bash
# Take the checkout's credential back out of the workspace, before a lens can read it.
#
# `run.sh` starts the orchestrator inside the workspace and every lens has `Bash`, so a
# credential reachable from the checkout is a credential a lens reads. review/DECISIONS.md,
# under "The GitHub token never enters the step that runs the agent", has the argument.
#
# `actions/checkout` stores it two different ways, and both have to go.
#
#   1. `http.<server>.extraheader` in the repository's own config. Older versions, and
#      anyone cloning by hand with a token in the url.
#   2. An `includeIf.gitdir:<workspace>/.git.path` in the repository's config, pointing at a
#      credentials file under `$RUNNER_TEMP` with the header inside it. This is what v6.0.2
#      does. The file is removed rather than dereferenced, because a lens reads it directly
#      whether or not any git config still points at it.
#
# `git config --local` does not expand `includeIf`, and a plain read does. Both were measured,
# and so was what the difference costs: the version of this script that went looking for the
# second shape with `--local` matched no key, read back no key, and exited 0 over a live
# credential for a whole review. So a scrub that reports nothing is not evidence that there
# was nothing to scrub.
#
# A script rather than a `run:` block, for the reason review/refuse-fork.sh gives. Whether this
# removes anything is not visible in its syntax, so what it decides is a table of cases in
# review/scrub-credentials.test.ts, which runs this script against a config built the way
# checkout builds one.
#
# Usage: scrub-credentials.sh <workspace>
#        scrub-credentials.sh --one <dir>   (one repository, no recursion; used by foreach)
#
# Exit: 0 nothing is reachable any more, or there is no repository at all,
#       1 something survived, or the workspace is not there.
set -uo pipefail

SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")

HEADER='^http\..*\.extraheader$'
INCLUDES='^includeif\..*\.path$'

removed=0

# `--local` on every read here: this is the file being edited, and a read that expanded an
# include would report a key `--unset-all` cannot remove.
scrub_repo() {
    local key path

    while IFS= read -r key; do
        [ -n "$key" ] || continue
        removed=1
        git config --local --unset-all "$key" || true
    done < <(git config --local --name-only --get-regexp "$HEADER" || true)

    while IFS= read -r key; do
        [ -n "$key" ] || continue

        path=$(git config --local --get "$key" || true)

        # A checkout writes one set of these for the runner's paths and another for the
        # container's, so a path that is not there is the ordinary case rather than a fault.
        if [ -n "$path" ] && [ -f "$path" ]; then
            rm -f "$path" || true
            removed=1
        fi

        git config --local --unset-all "$key" || true
    done < <(git config --local --name-only --get-regexp "$INCLUDES" || true)
}

# What is still reachable here, read the way a lens would read it: no `--local`, so includes
# are expanded and the global and system files are in scope too. The origin is printed because
# a value in a file this script cannot edit still has to be named.
reachable() {
    git config --show-origin --name-only --get-regexp "$HEADER" 2>/dev/null || true
}

if [ "${1:-}" = "--one" ]; then
    cd "${2:-.}" || exit 1
    scrub_repo
    [ "$removed" = 1 ] && echo "scrubbed $(pwd)"
    exit 0
fi

WORKSPACE=${1:-}

if [ -z "$WORKSPACE" ]; then
    echo "usage: scrub-credentials.sh <workspace>" >&2
    exit 1
fi

# Not skipped when the directory is missing. A quiet exit here leaves a credential where a
# lens can read it if the reasoning behind that exit is ever wrong, so the one case that
# exits 0 is named below and every other one fails.
cd "$WORKSPACE" || exit 1

# The named case: a caller who passed `checkout: skip` and has not cloned yet. With no
# repository there is no config, and so nothing holding a credential.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "no checkout in $WORKSPACE, so nothing holds a credential yet" >&2
    exit 0
fi

scrub_repo

if [ -f .gitmodules ]; then
    git submodule foreach --recursive --quiet "bash '$SELF' --one \"\$PWD\"" 2>/dev/null || true
fi

left=$(reachable)

if [ -f .gitmodules ]; then
    left="$left$(git submodule foreach --recursive --quiet \
        'git config --show-origin --name-only --get-regexp "^http\..*\.extraheader$" 2>/dev/null || true' 2>/dev/null || true)"
fi

if [ -n "${left//[[:space:]]/}" ]; then
    echo "a git credential is still reachable from $WORKSPACE, and a lens reads that tree:" >&2
    printf '%s\n' "$left" >&2
    exit 1
fi

if [ "$removed" = 1 ]; then
    echo "took the checkout's credential out of the workspace"
else
    echo "no git credential was reachable from $WORKSPACE"
fi
