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

run_dirs "$(session_run_dir)"
BUILD=$BUILD_DIR
FINDINGS="$BUILD/findings.json"

# run.sh writes the marker only when check-findings.ts passed, and the action posts nothing
# without it. A findings file that failed the check outright holds nothing worth posting, and
# one that passed has had whatever post-review.ts cannot render taken out.
require_checked_findings "$BUILD" "$PLUGIN" post || exit 1

# The commit the lenses actually read, taken from the arguments they were given rather
# than resolved again here. Every line the review names is a line of that commit, so a
# review taken at one commit and posted against another sends the reader to code nobody
# reviewed. reviewed-commit.ts owns how the file is read, beside the code that writes it.
# Out of the checkout and past the bunfig lookup: run.sh's `cd "$BUILD"` has why both.
if ! REVIEWED_HEAD=$(cd "$BUILD" && bun --config=/dev/null "$PLUGIN/review/reviewed-commit.ts" "$BUILD/diff-args"); then
    exit 1
fi

LOCAL_HEAD=$(git rev-parse HEAD)

if [ "$REVIEWED_HEAD" != "$LOCAL_HEAD" ]; then
    echo "the review was taken at $REVIEWED_HEAD and HEAD is now $LOCAL_HEAD." >&2
    echo "every finding's line is the reviewed commit's. Run the review again." >&2
    exit 1
fi

# The one condition in commands/review.md's posting gate that nothing but prose enforced.
# The two comparisons around it settle which commit the review names; neither covers the files
# the lenses read, and they read the working tree as they find it. So a review taken over a
# dirty tree quotes lines that are in no commit, and sends a reader of the pull request to
# code GitHub does not hold. Untracked files are not counted, for the reason
# local-preflight.sh gives where it reports the same number: nothing untracked reaches a diff,
# so a scratch file would otherwise block posting.
DIRTY=$(git status --porcelain --untracked-files=no | wc -l | tr -d '[:space:]')

if [ "$DIRTY" != "0" ]; then
    echo "$DIRTY tracked file(s) are uncommitted, and the lenses read files as they find them." >&2
    echo "commit or stash them and run the review again." >&2
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

# Read back here rather than in the run that produced the findings: run.sh leaves the file
# empty on purpose, and lib.sh has why. A failure leaves the empty file, which reopens every
# suppression, so the review repeats itself rather than going quiet.
printf '%s' "$GITHUB_TOKEN" | fetch_existing "$PLUGIN" "$BUILD" "$PR" "$(own_login)"

cd "$BUILD"

# A local review posts as whoever is at the keyboard, so `mine` cannot tell this run's
# threads from that person's own. local-run.sh sets the same value for the prompt the
# orchestrator gets; this is the half that the code answers to.
export RESOLVE_THREADS=0

exec bun --config=/dev/null "$PLUGIN/review/post-review.ts" "$FINDINGS" "$REVIEWED_HEAD" "$PR"
