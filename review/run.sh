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
#                     stops a finding being raised twice.
#   OWN_LOGIN         the account the review posts under, so it knows its own threads.
#   TOOLS             whitespace-separated static analysis tools to run before the review,
#                     naming files in review/tools/. Their reports are read by the
#                     `static-analysis` lens, which decides which findings hold. These run
#                     under PREFIX and need git and docker rather than the repository's
#                     own toolchain, so leave TOOLS empty where the prefix has neither.
#   RESOLVE_THREADS   Set to 0 to close no threads. Use 0 everywhere except CI.
#   GITHUB_TOKEN, GITHUB_REPOSITORY   needed when PR is set.
#   INCLUDE_WORKING_TREE  1 to review uncommitted work as well.
set -euo pipefail

BASE=${1:?usage: run.sh BASE_REF ACTION_PATH OUT_DIR WORKSPACE}
ACTION=${2:?missing action path}
OUT=${3:?missing output dir}
WORKSPACE=${4:?missing workspace}

BUILD="$OUT/build"
PREFIX=${PREFIX:-}

# The one measurement of trading capability for price went the wrong way: Sonnet spent
# 574k output tokens to find 29 things where Opus spent 412k to find 90.
MODEL=${MODEL:-opus}

# Empty leaves the model's own default. Nobody has measured what a lower effort does to a
# review here, so treat turning it down as a change to review quality and not only to the
# bill.
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
# under the holding name.
#
# The rest of the list is every other credential a runner or a shell puts in scope that
# nothing below needs. This is a denylist and a denylist is the weaker shape: an allowlist
# would need the full set of variables the Claude Code CLI reads to start, and a missing
# one fails the run twenty minutes in. So a variable the orchestrator should not see has
# to be named here.
unset -v token
token=${GITHUB_TOKEN:-}
unset -v GITHUB_TOKEN GH_TOKEN \
    ACTIONS_RUNTIME_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL \
    NPM_TOKEN NODE_AUTH_TOKEN

# An empty file costs duplicate comments, so the failure is written down here: nothing
# downstream can tell a pull request nobody has commented on from one whose comments
# went unread.
#
# The token goes over stdin. On a command line it would sit in the argument list of a
# process, which every other process on the machine can read, and under
# /codeferret:review this is the developer's own `gh` credential. `docker compose exec -T`
# passes stdin through, so a containerised toolchain is handed it the same way.
if [ -n "${PR:-}" ]; then
    printf '%s' "$token" |
        $PREFIX bun "$ACTION/review/fetch-existing.ts" \
            "$PR" "$BUILD/existing.json" ${OWN_LOGIN:+"$OWN_LOGIN"} ||
        echo "could not read this pull request's comments. Every finding will count as new." >&2
fi

# Overriding one of `tools` and `lenses` without the other is the ordinary customisation,
# and neither half fails on its own: it costs reports nobody reads, or a lens dispatched
# and paid for to say it found no reports. A warning here is cheaper than the bill.
tools_named=$(printf '%s' "${TOOLS:-}" | tr -d '[:space:]')

if printf '%s\n' "$LENSES" | tr -d '[:blank:]' | grep -qx static-analysis; then
    if [ -z "$tools_named" ]; then
        echo "the static-analysis lens is named but no tools are named. The lens will find no reports." >&2
    fi
elif [ -n "$tools_named" ]; then
    echo "tools are named but the static-analysis lens is not. Nothing will read their reports." >&2
fi

# Tools run before the dispatch, because their reports are input to a lens rather than
# output of the review. A tool that is not installed writes that down and returns 0.
#
# A name reaches here from a workflow input and from a model composing an environment in
# /codeferret:review, and it is pasted into a path that then gets executed. The lens names
# in build-prompts.sh come from the same two sources and carry the same guard. Globbing is
# off for the split, so the shell leaves a `*` alone instead of expanding it against the
# workspace.
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
        echo "tool '$tool' failed. The review carries on without its report." >&2
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

# The shape check runs whatever went wrong above, because the action decides whether to
# post on the marker this writes rather than on this script's exit code: a run that died
# after writing a good findings file is still worth posting, and one whose findings failed
# the check is not. A finding with no `line` reaches GitHub as a comment with no line, and
# the reviews endpoint answers 422 for the whole batch.
if [ -f "$BUILD/findings.json" ]; then
    if $PREFIX bun "$ACTION/review/check-findings.ts" "$BUILD/findings.json"; then
        printf 'ok' >"$BUILD/findings-checked"
        echo "findings: $BUILD/findings.json"
    elif [ "$status" -eq 0 ]; then
        status=1
    fi
fi

exit "$status"
