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
# twenty minutes. Where an event names no head repository at all, there is nothing to test and
# the step says so rather than passing in silence.
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

if [ "$EVENT" = "pull_request_target" ]; then
    echo "CodeFerret will not run under pull_request_target." >&2
    echo "Under that trigger the secrets reach a job that checks out a fork's commit." >&2
    echo "Use pull_request, and keep the head-repo test in the job's if:." >&2
    exit 1
fi

# The two payload fields that name where a commit came from, each spelled its own way:
# `pull_request` and its review events fill `HEAD_REPO`, `workflow_run` fills `RUN_REPO`, and
# every other event fills neither.
for named in "$HEAD_REPO" "$RUN_REPO"; do
    if [ -n "$named" ] && [ "$named" != "$THIS_REPO" ]; then
        echo "The commit this run would review is on $named, not on $THIS_REPO." >&2
        echo "CodeFerret runs an agent with Bash over the branch it reviews, in the" >&2
        echo "job holding your tokens, so it reviews only a branch from this repository." >&2
        echo "Add the head-repo test to the job's if: to skip such a run" >&2
        echo "rather than fail on it." >&2
        exit 1
    fi
done

# Said rather than refused. A workflow_dispatch or a repository_dispatch takes write access to
# start, so an input arriving on one was chosen by somebody who could have pushed the commit
# anyway. An issue_comment takes only the ability to comment, and its payload carries no head
# sha of its own, so whoever wired that trigger chose where the value came from and this script
# cannot see their choice.
#
# All three inputs, not `head-sha` alone. Each is a way to point the same job at somebody
# else's work: `head-sha` is the commit the checkout takes, `pr-number` decides which pull
# request the review reads and posts to, and `checkout: skip` hands the whole question to a
# step of the caller's own, which is where a `gh pr checkout` of a fork's branch goes.
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

if [ -n "$named" ]; then
    echo "$named names what this run reviews, and $EVENT carries no head repository" >&2
    echo "to check it against, so the job's if: is the only gate on whose code runs here." >&2
fi
