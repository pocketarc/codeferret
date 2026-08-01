#!/usr/bin/env bash
# Post the review a local run produced, to the pull request the branch has open.
#
# The pair of local-run.sh: it derives the run directory, the head commit and the gh
# credentials rather than having them pasted in. post-review.ts reads the pathspec back
# out of the run directory, so the two never disagree about which files were reviewed.
#
# Usage: local-post.sh <plugin-root> <base-ref> <pr-number>
#
# Env:
#   DRY_RUN  1 to print the review instead of posting it.
set -euo pipefail

PLUGIN=${1:?usage: local-post.sh PLUGIN_ROOT BASE_REF PR_NUMBER}
BASE=${2:?missing base ref}
PR=${3:?missing pull request number}

GIT_DIR=$(git rev-parse --absolute-git-dir)
FINDINGS="$GIT_DIR/codeferret/run/build/findings.json"

if [ ! -f "$FINDINGS" ]; then
    echo "no findings at $FINDINGS. Run the review first." >&2
    exit 1
fi

# The pushed commit, not the working tree's. Comments anchor to a commit GitHub holds.
HEAD_SHA=$(git rev-parse HEAD)

GITHUB_TOKEN=$(gh auth token)
GITHUB_REPOSITORY=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
export GITHUB_TOKEN GITHUB_REPOSITORY

exec bun "$PLUGIN/review/post-review.ts" "$FINDINGS" "$BASE" "$HEAD_SHA" "$PR"
