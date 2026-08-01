#!/usr/bin/env bash
# Run one review, from lens names to a checked findings file.
#
# The action calls this, and so does /codeferret:review. That is the point: a review is
# one sequence of steps, and two copies of it drift. Everything either caller varies goes
# in the environment below.
#
# The orchestrator runs here, in its own process, rather than in whoever's session asked
# for it. It reads a diff and pull request comments written by whoever opened them, and a
# session holds an editor, a shell, and whatever MCP servers its owner has connected.
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
#   PR                pull request number. Set it to have earlier comments read, which
#                     is what stops a finding being raised twice.
#   OWN_LOGIN         the account the review posts under, so it knows its own threads.
#   TOOLS             whitespace-separated static analysis tools to run before the review,
#                     naming files in review/tools/. Their reports are read by the
#                     `static-analysis` lens, which decides which findings hold.
#   RESOLVE_THREADS   0 to close no threads. Right anywhere but CI.
#   GITHUB_TOKEN, GITHUB_REPOSITORY   needed when PR is set.
#   INCLUDE_WORKING_TREE  1 to review uncommitted work as well.
set -euo pipefail

BASE=${1:?usage: run.sh <base-ref> <action-path> <out-dir> <workspace>}
ACTION=${2:?missing action path}
OUT=${3:?missing output dir}
WORKSPACE=${4:?missing workspace}

BUILD="$OUT/build"
PREFIX=${PREFIX:-}
MODEL=${MODEL:-opus}

# Unset by default, which leaves whatever the model does on its own. Lowering it is a
# review-quality decision and not only a cost one: the one measurement we have of trading
# capability for price went the wrong way, with Sonnet spending 574k output tokens to find
# 29 things where Opus spent 412k to find 90.
EFFORT=${EFFORT:-}
PERMISSION_MODE=${PERMISSION_MODE:-bypassPermissions}

: "${LENSES:?no lenses given}"

printf '%s\n' "$LENSES" |
    bash "$ACTION/review/build-prompts.sh" "$BASE" "$ACTION" "$OUT" "$WORKSPACE"

# Everything after this finds the repository from the working directory rather than from
# an argument: each tool asks git for a top level, and the orchestrator and its lenses
# read whatever tree their session started in. The action's step already starts in the
# workspace. A session, a linked worktree or a command prefix need not, and a tool that
# scanned a different tree from the one the lenses read would anchor its findings to
# paths the review does not contain.
ACTION=$(cd "$ACTION" && pwd)
cd "$WORKSPACE"

# fetch-existing.ts needs the GitHub token. The orchestrator must not have it: every lens
# it dispatches carries Bash, and `printenv GITHUB_TOKEN` is the whole attack. Hold the
# value here and hand it to the one command that needs it.
#
# The unset comes first because assigning to a name the caller exported leaves it
# exported, which would put the token straight back into the orchestrator's environment
# under the holding name. GH_TOKEN goes too: `gh` reads it, so it is already exported on
# the kind of machine /codeferret:review runs on, and it is a live credential itself.
unset -v token
token=${GITHUB_TOKEN:-}
unset -v GITHUB_TOKEN GH_TOKEN

# An empty file costs duplicate comments, so the failure is written down here: nothing
# downstream can tell a pull request nobody has commented on from one whose comments
# went unread.
#
# `env` rather than an assignment in front of the prefix: an assignment there sets the
# variable for `docker compose exec` and not for the process it starts inside the
# container.
if [ -n "${PR:-}" ]; then
    $PREFIX env GITHUB_TOKEN="$token" bun "$ACTION/review/fetch-existing.ts" \
        "$PR" "$BUILD/existing.json" ${OWN_LOGIN:+"$OWN_LOGIN"} ||
        echo "could not read this pull request's comments; every finding will count as new" >&2
fi

# Overriding one of `tools` and `lenses` without the other is the ordinary customisation,
# and neither half fails on its own: it costs reports nobody reads, or a lens dispatched
# and paid for to say it found no reports. Cheaper to hear it here than off the bill.
tools_named=$(printf '%s' "${TOOLS:-}" | tr -d '[:space:]')

if printf '%s\n' "$LENSES" | tr -d '[:blank:]' | grep -qx static-analysis; then
    if [ -z "$tools_named" ]; then
        echo "the static-analysis lens is named but no tools are: it will find no reports" >&2
    fi
elif [ -n "$tools_named" ]; then
    echo "tools are named but the static-analysis lens is not: nothing will read them" >&2
fi

# Tools run before the dispatch, because their reports are input to a lens rather than
# output of the review. A tool that is not installed writes that down and returns 0.
#
# A name reaches here from a workflow input and from a model composing an environment in
# /codeferret:review, and it is pasted into a path that then gets executed. The lens names
# in build-prompts.sh come from the same two sources and carry the same guard. Globbing is
# off for the split so a `*` cannot pick up filenames from the workspace on the way past.
set -f
for tool in ${TOOLS:-}; do
    case $tool in
    .* | *[!A-Za-z0-9._-]*)
        echo "tool name '$tool' is not a plain name" >&2
        exit 1
        ;;
    esac

    if [ ! -f "$ACTION/review/tools/$tool.ts" ]; then
        echo "no tool named '$tool' in $ACTION/review/tools/" >&2
        exit 1
    fi

    # A review that stops for want of a linter is worth less than one that runs without
    # it, and the tools already write down the failures they expect.
    $PREFIX bun "$ACTION/review/tools/$tool.ts" "$BUILD" ||
        echo "tool '$tool' failed; carrying on without its report" >&2
done
set +f

# The exit code is kept and returned at the end rather than stopping the script here,
# because extract-findings.ts writes what the run cost and what it was refused before it
# looks for findings, and a run that failed is the one those numbers matter most for.
status=0

# WebFetch and WebSearch are denied for the same reason scripts/build-lens-agents.ts
# leaves them off every lens: this session reads the pull request's comments, whoever
# wrote them, and holds CLAUDE_CODE_OAUTH_TOKEN in its environment. Bash still has curl,
# so this removes the one-call path without closing the hole. Agent has to stay: STEP 1
# of the orchestrator prompt dispatches every lens with it, and denying it leaves the run
# with nothing to merge.
$PREFIX claude -p "$(cat "$BUILD/orchestrator.txt")" \
    --model "$MODEL" \
    ${EFFORT:+--effort "$EFFORT"} \
    --output-format json \
    --json-schema "$(cat "$ACTION/review/merged-schema.json")" \
    --permission-mode "$PERMISSION_MODE" \
    --strict-mcp-config \
    --no-session-persistence \
    --disallowed-tools Edit Write NotebookEdit WebFetch WebSearch \
    --plugin-dir "$OUT" \
    >"$BUILD/run.json" || status=$?

if [ -s "$BUILD/run.json" ]; then
    extracted=0
    $PREFIX bun "$ACTION/review/extract-findings.ts" \
        "$BUILD/run.json" "$BUILD/findings.json" || extracted=$?

    if [ "$status" -eq 0 ]; then
        status=$extracted
    fi
fi

if [ "$status" -ne 0 ]; then
    exit "$status"
fi

$PREFIX bun "$ACTION/review/check-findings.ts" "$BUILD/findings.json"

echo "findings: $BUILD/findings.json"
