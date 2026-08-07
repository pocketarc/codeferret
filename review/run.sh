#!/usr/bin/env bash
# Run one review, from lens names to a checked findings file.
#
# The action calls this, and so does /codeferret:review. Everything either caller varies
# goes in the environment below.
#
# The orchestrator runs here, in a process of its own. It reads a diff and pull request
# comments written by whoever opened them, and the session that asked for it holds an
# editor, a shell, and whatever its owner has connected over MCP.
#
# Usage: run.sh <base-ref> <action-path> <out-dir> <workspace>
#
# Env:
#   LENSES            newline-separated lens names. Required.
#   EXCLUDE_PATHS     newline-separated globs kept out of the diff.
#   MODEL             defaults to opus.
#   PERMISSION_MODE   defaults to bypassPermissions, which suits a disposable runner.
#                     Use `auto` on somebody's own machine: it passes the reads a lens
#                     needs and refuses the rest, and refusals land in the run log.
#   PREFIX            prefix for `claude` and `bun`, for a containerised toolchain.
#   PR                pull request number. Set it to have the earlier comments and the
#                     previous run's findings read, which stops a finding being raised
#                     twice.
#   OWN_LOGIN         the account the review posts under. fetch-existing.ts marks a thread
#                     `mine` when the login and the marker earlier versions wrote both
#                     match.
#   RESOLVE_THREADS   0 to close no threads. Use 0 everywhere except CI.
#   GITHUB_TOKEN_FILE a file holding the token the GitHub fetches use, which this script
#                     reads and deletes. Needed with GITHUB_REPOSITORY when PR is set. A
#                     file rather than a variable: the block that reads it has why.
#   GITHUB_REPOSITORY the owner/name the fetches ask about.
#   INCLUDE_WORKING_TREE  1 to review uncommitted work as well.
set -euo pipefail

BASE=${1:?usage: run.sh BASE_REF ACTION_PATH OUT_DIR WORKSPACE}
ACTION=${2:?missing action path}
OUT=${3:?missing output dir}
WORKSPACE=${4:?missing workspace}

PREFIX=${PREFIX:-}

# The one measurement of trading capability for price went the wrong way: Sonnet spent
# 574k output tokens to find 29 things where Opus spent 412k to find 90.
MODEL=${MODEL:-opus}

EFFORT=${EFFORT:-}
PERMISSION_MODE=${PERMISSION_MODE:-bypassPermissions}

: "${LENSES:?no lenses given}"

# Checked here rather than left to the `claude` invocation at the end, which is after
# build-prompts and both GitHub fetches. A misspelling would otherwise be found by a CLI
# usage error that names no input, minutes into a run.
case ${EFFORT:-} in
"" | low | medium | high | xhigh | max) ;;
*)
    echo "effort is '$EFFORT'. It has to be low, medium, high, xhigh or max." >&2
    exit 1
    ;;
esac

# shellcheck source=review/lib.sh
. "$ACTION/review/lib.sh"

run_dirs "$OUT"
BUILD=$BUILD_DIR

prefix_reaches "$ACTION"

# The two GitHub fetches below need a token that can read the pull request. The
# orchestrator must not have it: every lens it dispatches carries Bash, and
# `printenv GITHUB_TOKEN` is the whole attack.
#
# So the value never enters this script's environment, because `unset` cannot take a value
# out of one. A process's environment block is written at execve, and /proc/<pid>/environ
# holds that block for as long as the process lives, whatever the shell unsets afterwards.
# A lens runs as the same user, so `tr '\0' '\n' </proc/$PPID/environ` reads back what the
# shell above it was started with, and the same read against each ancestor's pid reaches the
# rest. Measured in a Linux container: after `unset -v GITHUB_TOKEN` the shell's own
# /proc/self/environ still carried the value, and a grandchild whose own environment was
# clean read it out of the parent's.
#
# The caller leaves the token in a file instead and names it here. Its mode keeps other
# users out; what keeps a lens out is that the file is deleted now, long before anything
# starts an agent. The value spends the rest of the run in this shell's memory, which a
# descendant cannot read without ptrace on an ancestor.
#
# The unset comes first because assigning to a name the caller exported leaves it exported,
# which would put the token straight into the orchestrator's environment under the holding
# name.
unset -v token
token=""

if [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -f "$GITHUB_TOKEN_FILE" ]; then
    token=$(cat "$GITHUB_TOKEN_FILE")
    rm -f "$GITHUB_TOKEN_FILE"
fi

# Everything below is weaker than the file, and it is here for the credentials this script
# does not own. A caller's job may declare GITHUB_TOKEN of its own, and the runner puts
# ACTIONS_RUNTIME_TOKEN into every step's environment, so both arrive at execve and /proc
# keeps them whatever happens here. What the unset does is take them out of the environment
# every child is started with, which is what `printenv` in a lens reads. Like the WebFetch
# and WebSearch denials, it raises the cost rather than closing the channel.
#
# The rest of the list is the files a job step writes its own results to. Those files are
# not read-only: a line appended to GITHUB_PATH or GITHUB_ENV lands in every later step of
# the job, and the next one runs post-review.ts with a token of its own. The action's
# `emit_output` helper and summary.ts both run in the parent shell after this script has
# returned, which keeps its own copy of the environment, so removing them here costs nothing.
#
# Removing those names is not the same as putting the files out of reach. The runner creates
# them under `$RUNNER_TEMP/_runner_file_commands` before the job starts, and the orchestrator
# is handed build paths under `RUNNER_TEMP` anyway, so a lens with Bash can list the
# directory and append to a `set_env_` file whatever this shell exports. The toolchain is a
# second route to the same place: `install: auto` runs `npm install -g` as this user, so the
# `bun` the posting step resolves through PATH is a file the review session can overwrite.
#
# Both end in the next step of this job running code a lens chose, holding the token that
# posts. What would close it is posting from a job that never runs the agent, and a composite
# action has steps rather than jobs, so that is a change for whoever installs this to make,
# not one available here.
#
# This is a denylist and a denylist is the weaker shape: an allowlist would need the full
# set of variables the Claude Code CLI reads to start, and a missing one fails the run
# twenty minutes in. So a variable the orchestrator should not see has to be named here.
unset -v GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN_FILE \
    ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL \
    NPM_TOKEN NODE_AUTH_TOKEN \
    GITHUB_ENV GITHUB_PATH GITHUB_OUTPUT GITHUB_STATE GITHUB_STEP_SUMMARY

# Whether a composite action's inputs reach its `run:` steps as INPUT_<NAME> is undocumented
# and has changed before. Where they do, both tokens are in scope a second time under names
# the list above does not mention. Nothing below reads one: every value this script needs
# arrives as an argument or under its own name.
for name in $(compgen -e | grep '^INPUT_' || true); do
    unset -v "$name"
done

# PREFIX goes with it because build-prompts.sh runs bun too, to render an agent for a lens
# the action does not bundle, and because the build directory's own reachability is checked
# in there: it does not exist until that script creates it, and the first `$PREFIX bun`
# after that would create it inside the container and hide the answer.
printf '%s\n' "$LENSES" |
    PREFIX="$PREFIX" bash "$ACTION/review/build-prompts.sh" "$BASE" "$ACTION" "$OUT" "$WORKSPACE"

# Every `bun` a review starts is given `--config=/dev/null`. Without it, bun reads the
# `bunfig.toml` in whatever directory a run stands in and runs the script that file names,
# inside the job holding the tokens. "Bun runs whatever a `bunfig.toml` in the reviewed tree
# names" in review/README.md has why the working directory alone does not settle it.
#
# The working directory still moves, because a relative path in a report or an argument
# resolves against it. Only the orchestrator starts in the workspace, and it does so in a
# subshell below, because its lenses read whatever tree their session started in. The tools
# take the workspace as an argument.
ACTION=$(cd "$ACTION" && pwd)
cd "$BUILD"

# An empty file costs duplicate comments, so the failure is written down here: nothing
# downstream can tell a pull request nobody has commented on from one whose comments
# went unread.
#
# The token goes over stdin. On a command line it would sit in the argument list of a
# process, which every other process on the machine can read, and under
# /codeferret:review this is the developer's own `gh` credential. `docker compose exec -T`
# passes stdin through, so a containerised toolchain is handed it the same way.
#
# Nothing else crosses that boundary: `docker compose exec` starts a process with the
# container's environment and not this shell's. Both scripts exit 2 without
# GITHUB_REPOSITORY, and the `||` below would report that as a pull request nobody had
# commented on, so the two values they read go across as arguments to `env`. Neither is
# secret; the token is the one that stays off an argument list.
across=(env "GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-}" "GITHUB_RUN_ID=${GITHUB_RUN_ID:-}")

# Half the fetch can fail on its own. fetch-existing.ts writes the half that came back and
# names the half that did not, and the orchestrator treats only the named half as unread, so
# the message below is true either way, where reporting the whole file as empty would not be.
#
# A function because this runs twice: once for the orchestrator to read, and again after it
# has exited, for the two scripts that re-decide what it settled.
fetch_existing() {
    printf '%s' "$token" |
        $PREFIX "${across[@]}" bun --config=/dev/null "$ACTION/review/fetch-existing.ts" \
            "$PR" "$BUILD/existing.json" ${OWN_LOGIN:+"$OWN_LOGIN"} ||
        echo "could not read all of this pull request's comments. Whatever went unread counts as new." >&2
}

if [ -n "${PR:-}" ]; then
    # Reported apart from the two `||` messages below, because both scripts fail the same way
    # whether the token was wrong or never staged at all, and a caller who moved the file
    # would otherwise read the empty result as a pull request nobody had commented on.
    if [ -z "$token" ]; then
        echo "no token was staged for pull request #$PR, so its comments cannot be read." >&2
    fi

    fetch_existing

    # What the last run raised is in its own findings file, which needs `actions: read` to
    # read back. The shipped workflow grants it and a consumer can decline it, so this is
    # allowed to come back empty. fetch-previous.ts reports its own failures, so the `||`
    # is for a failure before it can.
    printf '%s' "$token" |
        $PREFIX "${across[@]}" bun --config=/dev/null "$ACTION/review/fetch-previous.ts" \
            "$PR" "$BUILD/previous.json" ||
        echo "could not read the previous run's findings. Every finding will count as new." >&2
fi

# The exit code is kept and returned at the end rather than stopping the script here,
# because extract-findings.ts writes what the run cost and what it was refused before it
# looks for findings, and a run that failed is the one those numbers matter most for.
status=0

# Copied before the session and put back after it, for the reason the block below the
# orchestrator gives. Each decides something once the review has ended: `diff.sh` and
# `diff-args` are between them the diff every lens read, and reviewed-commit.ts takes from
# the second the commit local-post.sh refuses to post against; check-findings.ts reads
# `lens-list.txt` for the one check that catches a lens that ran and reported nothing about
# itself; and `vetSuppression` reads `previous.json` for whether the last review raised
# anything in the file of a finding this run says was raised before. None of them can move
# out of the build directory (diff.sh reads its arguments from beside itself, and the prompts
# name every path), so a copy is what there is. A lens with Bash could find this one too;
# what it buys is that a rewritten file is reported instead of believed.
#
# One list, used twice. Copied without comparing, tampering with a file goes unreported;
# compared without copying, `cmp` and then `cp` both fail against a file that is not there
# and `set -e` kills the job after the review has been paid for.
PINNED=(diff-args diff.sh lens-list.txt previous.json)
PRISTINE=$(mktemp -d)
trap 'rm -rf "$PRISTINE"' EXIT

for pinned in "${PINNED[@]}"; do
    cp "$BUILD/$pinned" "$PRISTINE/"
done

# WebFetch and WebSearch are denied for the reason scripts/build-lens-agents.ts gives for
# leaving them off every lens. Agent has to stay: STEP 1 of the orchestrator prompt
# dispatches every lens with it, and denying it leaves the run with nothing to merge.
#
# `--setting-sources user` keeps the reviewed tree out of the session's own configuration.
# The session starts in that tree, and a SessionStart hook declared there runs even under
# bypassPermissions. Plugins passed with --plugin-dir still load, so the lens agents are
# unaffected. "The reviewed tree does not configure the session" in review/README.md has
# what was measured and how.
(
    cd "$WORKSPACE" &&
        $PREFIX claude -p "$(cat "$BUILD/orchestrator.txt")" \
            --model "$MODEL" \
            ${EFFORT:+--effort "$EFFORT"} \
            --output-format json \
            --json-schema "$(cat "$ACTION/review/merged-schema.json")" \
            --permission-mode "$PERMISSION_MODE" \
            --strict-mcp-config \
            --setting-sources user \
            --no-session-persistence \
            --disallowed-tools Edit Write NotebookEdit WebFetch WebSearch \
            --plugin-dir "$OUT"
) >"$PRISTINE/run.json" || status=$?

# Not into the build directory, which findings.json is derived from and which the session
# knows: its dispatch prompt names `build/diff-args`. The shell holds the redirect, so a lens
# cannot corrupt the bytes claude is writing, but anything appended past the end survives and
# extract-findings.ts reads exactly that. Trailing bytes fail the whole-file parse, the
# line-by-line fallback runs, and the last line whose `type` is `result` becomes the merged
# findings the review is built from, posted under the account that holds `pull-requests:
# write`. Deleting findings.json below covers the file the review is built from; this covers
# the file that one is extracted from.
#
# `$PRISTINE` is a fresh mktemp directory named in no prompt. Like the copies taken into it
# above, that raises the cost rather than closing the channel: a lens with Bash runs as this
# user and can look.
#
# Not fatal. A session killed before it wrote a byte already reaches the `-f` test below, and
# dying here instead would lose the cost and the refusals that run wrote.
cp "$PRISTINE/run.json" "$BUILD/run.json" ||
    echo "the run log could not be put beside the findings. Nothing will be extracted from it." >&2

# The orchestrator ran with Bash under bypassPermissions and knows this directory: its
# dispatch prompt names `build/diff-args`, and build-prompts.sh puts the two json paths into
# the prompt itself. Every file below decides something after the session has ended, and
# none of them is evidence unless the step that earns it wrote it during this run. So each
# path is cleared here, and what comes next puts it back or it does not.
#
# findings.json and findings-checked are what the action posts on. post-review.ts and
# print-findings.ts re-decide every suppression and every thread closure against
# existing.json, and the orchestrator could have written the copy it was handed. So the file
# is fetched again from GitHub, and the fresh copy has whatever was said during the twenty
# minutes the review took. The empty file is written first, so a fetch that fails before it
# writes leaves nothing traced and every suppression reopened.
#
# The rest cannot be re-derived here without running build-prompts.sh again or paying for
# another artifact download, so the copies taken before the session go back instead. A
# difference is reported rather than swallowed: it means the session rewrote what the lenses
# were diffing, or the record its own suppressions are checked against.
rm -f "$BUILD/findings.json" "$BUILD/findings-checked" "$BUILD/existing.json"
empty_existing "$BUILD/existing.json"

for pinned in "${PINNED[@]}"; do
    if ! cmp -s "$PRISTINE/$pinned" "$BUILD/$pinned"; then
        echo "$pinned changed during the review. The lenses did not all read the same diff." >&2
    fi

    cp "$PRISTINE/$pinned" "$BUILD/$pinned"
done

if [ -n "${PR:-}" ]; then
    fetch_existing
fi

# `-f` and not `-s`: a session killed before it wrote a byte leaves this file empty, and that
# is the run extract-findings.ts writes `none reported` and `unknown` for. Skip it and the run
# files are never written at all, and the action's `findings-count` output comes back as an
# empty string, which action.yml documents as `none reported`.
if [ -f "$BUILD/run.json" ]; then
    extracted=0
    $PREFIX bun --config=/dev/null "$ACTION/review/extract-findings.ts" \
        "$BUILD/run.json" "$BUILD/findings.json" || extracted=$?

    if [ "$status" -eq 0 ]; then
        status=$extracted
    fi
fi

# The shape check runs whatever went wrong above, because the marker it writes is what the
# action posts on. Exit 3 means it dropped what it could not use and left a file worth
# posting, so the marker goes down and the run still ends red.
if [ -f "$BUILD/findings.json" ]; then
    checked=0
    $PREFIX bun --config=/dev/null "$ACTION/review/check-findings.ts" "$BUILD/findings.json" || checked=$?

    if [ "$checked" -eq 0 ] || [ "$checked" -eq 3 ]; then
        printf 'ok' >"$BUILD/findings-checked"
        echo "findings: $BUILD/findings.json"
    fi

    if [ "$checked" -ne 0 ] && [ "$status" -eq 0 ]; then
        status=1
    fi
fi

exit "$status"
