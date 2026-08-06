#!/usr/bin/env bash
# Post the review a local run produced, to the pull request the branch has open.
#
# The pair of local-run.sh: it derives the run directory, the reviewed commit and the gh
# credentials rather than having them pasted in. Everything about which diff was reviewed
# is read back out of the run directory, so this and post-review.ts never disagree with
# the lenses about what they read.
#
# Usage: local-post.sh <plugin-root> <pr-number>
#
# Env:
#   DRY_RUN  1 to print the review instead of posting it.
set -euo pipefail

PLUGIN=${1:?usage: local-post.sh PLUGIN_ROOT PR_NUMBER}
PR=${2:?missing pull request number}

# shellcheck source=review/lib.sh
. "$PLUGIN/review/lib.sh"

# A model following commands/review.md pastes this from the preflight's `pr=` line.
if ! plain_number "$PR"; then
    echo "pull request number '$PR' is not a number" >&2
    exit 1
fi

GIT_DIR=$(git rev-parse --absolute-git-dir)
BUILD="$GIT_DIR/codeferret/run/build"
FINDINGS="$BUILD/findings.json"

if [ ! -f "$FINDINGS" ]; then
    echo "no findings at $FINDINGS. Run the review first." >&2
    exit 1
fi

# run.sh writes this marker only when check-findings.ts passed, and the action refuses to
# post without it. A findings file that failed the check outright holds nothing worth
# posting, and one that passed has had whatever post-review.ts cannot render taken out.
if [ ! -f "$BUILD/findings-checked" ]; then
    echo "$FINDINGS did not pass check-findings.ts, so it is not safe to post." >&2
    echo "run: bun '$PLUGIN/review/check-findings.ts' '$FINDINGS'" >&2
    exit 1
fi

# The commit the lenses actually read, taken from the arguments they were given rather
# than resolved again here. Every line the review names is a line of that commit, so a
# review taken at one commit and posted against another sends the reader to code nobody
# reviewed. reviewed-commit.ts owns how the file is read, beside the code that writes it.
# Run from the build directory, not from the checkout: run.sh's `cd "$BUILD"` has why.
if ! REVIEWED_HEAD=$(cd "$BUILD" && bun "$PLUGIN/review/reviewed-commit.ts" "$BUILD/diff-args"); then
    exit 1
fi

LOCAL_HEAD=$(git rev-parse HEAD)

if [ "$REVIEWED_HEAD" != "$LOCAL_HEAD" ]; then
    echo "the review was taken at $REVIEWED_HEAD and HEAD is now $LOCAL_HEAD." >&2
    echo "every finding's line is the reviewed commit's. Run the review again." >&2
    exit 1
fi

gh_credentials

if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_REPOSITORY" ]; then
    echo "gh could not supply a token and a repository name, and posting needs both." >&2
    echo "run: gh auth login" >&2
    exit 1
fi

# Whether GitHub holds the reviewed commit, which is the one recorded on the review. Asked
# of the pull request rather than of `origin/<branch>`, for the reason local-preflight.sh
# gives where it answers the same question.
if ! REMOTE_HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid); then
    echo "gh could not read pull request #$PR, so nothing here knows what GitHub holds." >&2
    echo "check that it is open and that gh is authenticated for this repository." >&2
    exit 1
fi

if [ "$REMOTE_HEAD" != "$REVIEWED_HEAD" ]; then
    echo "the pull request's head is $REMOTE_HEAD and the review covers $REVIEWED_HEAD." >&2
    echo "push the reviewed commit, or run the review again against what is pushed." >&2
    exit 1
fi

cd "$BUILD"

exec bun "$PLUGIN/review/post-review.ts" "$FINDINGS" "$REVIEWED_HEAD" "$PR"
