#!/usr/bin/env bash
# Refuse to review a commit that is not this repository's.
#
# The action's first step runs this, before anything has read the tree. This action's trust
# boundary is the caller's `if:`, which nothing here can see. What it can check is the ways
# that gate stops holding by accident, and none of them is a configuration anybody means.
#
# Under `pull_request_target` the event's head sha is the fork's commit and the secrets are
# available, which is how this class of action is usually compromised. The shipped template's
# gate happens to survive the trigger change, but only by accident of what it tests.
#
# A caller who keeps `pull_request` and drops the head-repo test gets the same thing, and that
# is a plausible edit: "why won't it review external pull requests?". With `checkout: auto` the
# next steps check out that commit and start an agent with `Bash` under `bypassPermissions`
# over it, in a job holding the OAuth token and `pull-requests: write`.
#
# `workflow_run` is the other trigger that pairs a fork's commit with the secrets, and the one
# people reach for after reading that `pull_request_target` is refused. That event fires with
# the workflow file as the default branch has it, and its payload carries the head sha of
# whatever ran before it, a fork's pull request included. The `head-sha` input is what turns
# that into a checkout, so the head repository it names is tested here under its own spelling.
#
# The action refuses rather than warns, and refuses here rather than after a review that took
# twenty minutes. Where an event names no head repository there is nothing to test it against,
# and such a run is refused unless `unverified-head` is set to 'allow', which puts the decision
# in the caller's workflow beside the `if:` that already decides who may start the job. A
# dispatch takes write access to start, so whoever passed the input could have pushed the
# commit anyway; `issue_comment` takes no more than the ability to comment, which on a public
# repository is anybody.
#
# A script rather than a `run:` block, for the reason review/artifact-path.ts gives one step
# further down: shell inside a YAML string has shellcheck for its only reader, and shellcheck
# reads syntax. Not a bun module like that one, because this is the step before the toolchain
# is installed, and because `command-prefix` runs every `bun` inside a container the caller
# supplied. A boundary against somebody else's commit is the wrong thing to hand to either.
# So what it decides is a table of cases in review/refuse-fork.test.ts, which runs this script.
#
# Usage: refuse-fork.sh
#
# Env:
#   EVENT      github.event_name.
#   HEAD_REPO  github.event.pull_request.head.repo.full_name.
#   RUN_REPO   github.event.workflow_run.head_repository.full_name.
#   THIS_REPO  github.repository.
#   HEAD_SHA   the head-sha input.
#   PR_NUMBER  the pr-number input.
#   CHECKOUT   the checkout input.
#   UNVERIFIED_HEAD  the unverified-head input: refuse or allow.
#   WORKSPACE  github.workspace, to see a checkout the caller made for themselves.
#
# Exit: 0 nothing names a commit from elsewhere, 1 refused with the reason on stderr.
set -euo pipefail

EVENT=${EVENT:-}
HEAD_REPO=${HEAD_REPO:-}
RUN_REPO=${RUN_REPO:-}
THIS_REPO=${THIS_REPO:-}
HEAD_SHA=${HEAD_SHA:-}
PR_NUMBER=${PR_NUMBER:-}
CHECKOUT=${CHECKOUT:-}
UNVERIFIED_HEAD=${UNVERIFIED_HEAD:-refuse}
WORKSPACE=${WORKSPACE:-}

# Here rather than beside the branch that reads it, so a misspelt value stops the run on every
# event instead of on the ones nobody tests with.
case $UNVERIFIED_HEAD in
refuse | allow) ;;
*)
    echo "unverified-head is '$UNVERIFIED_HEAD'. It must be 'refuse' or 'allow'." >&2
    exit 1
    ;;
esac

if [ "$EVENT" = "pull_request_target" ]; then
    echo "CodeFerret will not run under pull_request_target." >&2
    echo "Under that trigger the secrets reach a job that checks out a fork's commit." >&2
    echo "Use pull_request, and keep the head-repo test in the job's if:." >&2
    exit 1
fi

# The two payload fields that name where a commit came from, each spelled its own way:
# `pull_request` and its review events fill `HEAD_REPO`, `workflow_run` fills `RUN_REPO`, and
# every other event fills neither.
for repo in "$HEAD_REPO" "$RUN_REPO"; do
    if [ -n "$repo" ] && [ "$repo" != "$THIS_REPO" ]; then
        echo "The commit this run would review is on $repo, not on $THIS_REPO." >&2
        echo "CodeFerret runs an agent with Bash over the branch it reviews, in the" >&2
        echo "job holding your tokens, so it reviews only a branch from this repository." >&2
        echo "Add the head-repo test to the job's if: to skip such a run" >&2
        echo "rather than fail on it." >&2
        exit 1
    fi
done

# Below here the payload names no head repository, so all this script can still read is how
# the caller pointed the job at a commit. A checkout already in the workspace counts as one of
# those routes: it is `checkout` left at its default, because the probe in action.yml leaves
# whatever it finds alone.
if [ -n "$HEAD_REPO" ] || [ -n "$RUN_REPO" ]; then
    exit 0
fi

named=""

name_route() {
    if [ -z "$named" ]; then
        named=$1
    else
        named="$named, $1"
    fi
}

if [ -n "$HEAD_SHA" ]; then
    name_route "head-sha"
fi

if [ -n "$PR_NUMBER" ]; then
    name_route "pr-number"
fi

if [ "$CHECKOUT" = "skip" ]; then
    name_route "checkout: skip"
fi

# Asked here rather than read off the probe step, which runs after this one: this is the last
# point at which the answer can still stop a run.
if [ -n "$WORKSPACE" ] && [ -d "$WORKSPACE/.git" ]; then
    name_route "a checkout this action did not make"
fi

if [ -z "$named" ]; then
    exit 0
fi

if [ "$UNVERIFIED_HEAD" = "allow" ]; then
    echo "$named names what this run reviews, and $EVENT carries no head repository" >&2
    echo "to check it against, so the job's if: is the only gate on whose code runs here." >&2
    exit 0
fi

echo "$named names what this run reviews, and $EVENT carries no head repository to check" >&2
echo "it against. CodeFerret runs an agent with Bash over the branch it reviews, in the job" >&2
echo "holding your tokens, and an issue_comment needs no more than the ability to comment." >&2
echo "Restrict who may start the job, then set unverified-head: allow to record that." >&2
exit 1
