#!/usr/bin/env bash
# Take the checkout's credential back out of the workspace, before a lens can read it.
#
# `actions/checkout` defaults `persist-credentials` to true, so the token it cloned with
# stays in the workspace's git config as an `http.<server>.extraheader` holding
# `x-access-token:<token>` in base64. `run.sh` starts the orchestrator inside that workspace
# and every lens has `Bash`, so a lens running `git config --get-regexp extraheader` reads
# out the same token the token-staging step goes to lengths to keep out of an environment
# block. Five lenses found it.
#
# The step that calls this runs after the last fetch that needs the credential and before
# the review session starts, which is the whole of the ordering constraint.
#
# Unsetting here rather than setting `persist-credentials: false` on the checkout covers the
# caller who checks out for themselves: the probe step then skips this action's own
# checkout, so a flag there would sit on a step that never runs while the caller's config
# still holds the token.
#
# Submodules are a config of their own. `actions/checkout` with `submodules` writes the same
# key into each one, via `git submodule foreach --recursive git config --local
# http.<server>.extraheader ...`, and it lands in `.git/modules/<name>/config`, which
# `git config --local` in the superproject does not see. `action.yml`'s `checkout` input and
# review/README.md both name submodules as the reason to check out yourself, so that shape
# is the documented one rather than an exotic case.
#
# A script rather than a `run:` block, for the reason review/refuse-fork.sh gives: shell
# inside a YAML string has shellcheck for its only reader, and shellcheck reads syntax. The
# correctness of this one turns on something syntax cannot see, which is that the read-back
# at the end reads `git config --get-regexp`'s exit code as "a key is still set" — the
# inverse of how the same command is used as a loop source above it. Get that polarity wrong
# and the step passes while leaving the token in place, which is the failure it exists to
# prevent, reported as success. So what it decides is a table of cases in
# review/scrub-credentials.test.ts, which runs this script.
#
# Usage: scrub-credentials.sh <workspace>
#
# Exit: 0 the workspace holds no such key any more (or holds no repository at all),
#       1 a key survived, or the workspace is not there.
set -uo pipefail

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

# The pattern matches every server rather than github.com, because the key carries the
# server URL and that is the Enterprise host on an Enterprise runner.
KEYS='^http\..*\.extraheader$'

found=0

# Process substitution rather than a pipe, so `found` is set in this shell rather than in
# one that ends with the loop.
while IFS= read -r key; do
    found=1
    git config --local --unset-all "$key" || true
done < <(git config --local --name-only --get-regexp "$KEYS" || true)

# `foreach` runs in each submodule's working tree with that submodule's config as `--local`,
# and `--recursive` reaches a submodule of a submodule. Guarded on `.gitmodules` so an
# ordinary repository does not pay for a shell per submodule that is not there.
if [ -f .gitmodules ]; then
    submodule_output=$(git submodule foreach --recursive --quiet \
        'git config --local --name-only --get-regexp "^http\..*\.extraheader$" |
             while IFS= read -r key; do
                 printf "%s\n" "$key"
                 git config --local --unset-all "$key" || true
             done' 2>/dev/null || true)

    if [ -n "$submodule_output" ]; then
        found=1
    fi
fi

# Read back rather than trusting the unsets above, which are all `|| true`. A key that
# survives leaves the credential in the tree the review reads.
left=""

if git config --local --name-only --get-regexp "$KEYS" >/dev/null 2>&1; then
    left="the checkout"
fi

if [ -f .gitmodules ]; then
    surviving=$(git submodule foreach --recursive --quiet \
        'git config --local --name-only --get-regexp "^http\..*\.extraheader$" || true' 2>/dev/null || true)

    if [ -n "$surviving" ]; then
        left="${left:+$left and }a submodule"
    fi
fi

if [ -n "$left" ]; then
    echo "the credential is still in $left's git config, and a lens reads that tree" >&2
    exit 1
fi

if [ "$found" = 1 ]; then
    echo "took the checkout's credential out of the workspace's git config"
fi
