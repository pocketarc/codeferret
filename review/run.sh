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
PERMISSION_MODE=${PERMISSION_MODE:-bypassPermissions}

: "${LENSES:?no lenses given}"

printf '%s\n' "$LENSES" |
    bash "$ACTION/review/build-prompts.sh" "$BASE" "$ACTION" "$OUT" "$WORKSPACE"

# fetch-existing.ts needs the GitHub token. The orchestrator must not have it: every lens
# it dispatches carries Bash, and `printenv GITHUB_TOKEN` is the whole attack. Hold the
# value here and hand it to the one command that needs it.
GH_TOKEN=${GITHUB_TOKEN:-}
unset GITHUB_TOKEN

# An empty file costs duplicate comments; a failure here would cost the whole review.
if [ -n "${PR:-}" ]; then
    GITHUB_TOKEN="$GH_TOKEN" $PREFIX bun "$ACTION/review/fetch-existing.ts" \
        "$PR" "$BUILD/existing.json" ${OWN_LOGIN:+"$OWN_LOGIN"} || true
fi

$PREFIX claude -p "$(cat "$BUILD/orchestrator.txt")" \
    --model "$MODEL" \
    --output-format json \
    --json-schema "$(cat "$ACTION/review/merged-schema.json")" \
    --permission-mode "$PERMISSION_MODE" \
    --strict-mcp-config \
    --no-session-persistence \
    --disallowed-tools Edit Write NotebookEdit \
    --plugin-dir "$OUT" \
    >"$BUILD/run.json"

$PREFIX bun "$ACTION/review/extract-findings.ts" "$BUILD/run.json" "$BUILD/findings.json"
$PREFIX bun "$ACTION/review/check-findings.ts" "$BUILD/findings.json"

echo "findings: $BUILD/findings.json"
