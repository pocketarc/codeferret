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
#   EXCLUDE_LENSES    newline-separated lens names to drop from LENSES, for a caller who
#                     wants the set minus one without restating the rest.
#   EXCLUDE_PATHS     newline-separated globs kept out of the diff.
#   MODEL             defaults to opus.
#   EFFORT            low, medium, high, xhigh or max. Empty leaves the model's own default.
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
#   RESOLVE_THREADS   1 to close the threads the review judges finished. Anything else
#                     closes none, which is right everywhere except CI.
#   GITHUB_TOKEN_FILE a file holding the token the GitHub fetches use, which this script
#                     reads and deletes. Needed with GITHUB_REPOSITORY when PR is set. A
#                     file rather than a variable: the block that reads it has why.
#   GITHUB_REPOSITORY the owner/name the fetches ask about.
#   INCLUDE_WORKING_TREE  1 to review uncommitted work as well.
set -euo pipefail

# Whether a composite action's inputs reach its `run:` steps as INPUT_<NAME> is undocumented
# and has changed before. Where they do, both tokens are in scope a second time, under names
# the denylist further down does not mention, and a lens holds Bash. Nothing in this script
# reads one: every value it needs arrives as an argument or under its own name.
#
# `unset` cannot take them out. The runner uppercases an input name and replaces its spaces
# with underscores, leaving the dashes, so the token inputs arrive as `INPUT_GITHUB-TOKEN` and
# `INPUT_CLAUDE-CODE-OAUTH-TOKEN`, and neither is a valid shell identifier. Measured under
# bash 3.2, which is what a Mac runs: `compgen -e` lists both, `unset -v 'INPUT_GITHUB-TOKEN'`
# answers "not a valid identifier", and `set -e` ends the review on that line. Under a bash
# that leaves them out of `compgen -e` the same loop passes and removes nothing.
#
# `env -u` names a variable a shell cannot, so the script re-execs through it once, before it
# has read the caller's token file or written anything. The list comes from `env` rather than
# being written out here, so an input added later is covered without anyone remembering this
# block; a line that is only some value's embedded newline costs a `-u` for a name that does
# not exist.
if [ -z "${CODEFERRET_INPUTS_SCRUBBED:-}" ]; then
    scrub=()

    while IFS='=' read -r name _; do
        case $name in
        INPUT_*) scrub+=(-u "$name") ;;
        esac
    done < <(env)

    # Every `-u` ahead of the assignment: `env` reads the first `name=value` as the end of its
    # own options, and a `-u` after it is the command to run. `env: -u: No such file or
    # directory` is what that looks like, and it costs the whole review.
    exec env "${scrub[@]+"${scrub[@]}"}" CODEFERRET_INPUTS_SCRUBBED=1 bash "$0" "$@"
fi

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

# shellcheck source=review/lib.sh
. "$ACTION/review/lib.sh"

run_dirs "$OUT"
BUILD=$BUILD_DIR
SESSION=$SESSION_DIR

# The token arrives in a file, not this script's environment: `unset` cannot take a value
# back out of a process that was started with it. "The GitHub token never enters the step
# that runs the agent" in review/DECISIONS.md has the measurement.
unset -v token
token=""

if [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -f "$GITHUB_TOKEN_FILE" ]; then
    token=$(cat "$GITHUB_TOKEN_FILE")
    rm -f "$GITHUB_TOKEN_FILE"
fi

# Every guard on what the caller asked for sits below the block above rather than beside the
# value it checks. A rejected value exits, and exiting while the caller's credential is still
# sitting in the run directory leaves it there with nothing left running to clear it:
# /codeferret:review stages somebody's own `gh` token and then execs, so no trap of its own
# survives to tidy up. The lens check and `prefix_reaches` used to sit above the block and
# left a plaintext token behind on every exit they took. Every guard is still ahead of
# build-prompts, both fetches and the session, which is what keeps a misspelt input from
# being found by a CLI usage error twenty minutes in.
case ${EFFORT:-} in
"" | low | medium | high | xhigh | max) ;;
*)
    echo "effort is '$EFFORT'. It has to be low, medium, high, xhigh or max." >&2
    exit 1
    ;;
esac

: "${LENSES:?no lenses given}"

prefix_reaches "$ACTION"

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

# The `INPUT_*` names are already gone: the block at the top of this script re-execs through
# `env -u`, because `unset` cannot name a variable with a dash in it.

# Which lenses this run dispatches, decided in review/select-lenses.ts, which has why the
# subtraction exists and why an exclusion that matches nothing is a line on stderr rather than
# a failure. It was a `trim`, a `while read` loop and a `grep -vxF` here, and nothing tested
# any of it: a case no test covered reached shipped configuration and killed every consumer run.
#
# This `bun` writes nothing, so it cannot be the one that creates the build directory inside
# a container and leaves `prefix_reaches` answering yes about a path only the container has.
kept=$($PREFIX bun --config=/dev/null "$ACTION/review/select-lenses.ts" \
    "$LENSES" "${EXCLUDE_LENSES:-}")

# PREFIX goes with it because build-prompts.sh runs bun too, to render an agent for a lens
# the action does not bundle, and because the build directory's own reachability is checked
# in there: it does not exist until that script creates it, and the first `$PREFIX bun`
# after that would create it inside the container and hide the answer.
printf '%s\n' "$kept" |
    PREFIX="$PREFIX" bash "$ACTION/review/build-prompts.sh" "$BASE" "$ACTION" "$OUT" "$WORKSPACE"

# Every `bun` a review starts is given `--config=/dev/null`. Without it, bun reads the
# `bunfig.toml` in whatever directory a run stands in and runs the script that file names,
# inside the job holding the tokens. "Bun runs whatever a `bunfig.toml` in the reviewed tree
# names" in review/DECISIONS.md has why the working directory alone does not settle it.
#
# The working directory still moves, because a relative path in a report or an argument
# resolves against it. Only the orchestrator starts in the workspace, below, because its
# lenses read whatever tree their session started in.
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
# commented on, so every value they read goes across as an argument to `env`. None of them is
# secret; the token is the one that stays off an argument list.
if [ -n "${PR:-}" ]; then
    # Reported apart from the two `||` messages below, because both scripts fail the same way
    # whether the token was wrong or never staged at all, and a caller who moved the file
    # would otherwise read the empty result as a pull request nobody had commented on.
    if [ -z "$token" ]; then
        echo "no token was staged for pull request #$PR, so its comments cannot be read." >&2
    fi

    # Half the fetch can fail on its own. fetch-existing.ts writes the half that came back
    # and names the half that did not, and the orchestrator treats only the named half as
    # unread, so the message `fetch_existing` prints is true either way, where reporting the
    # whole file as empty would not be.
    printf '%s' "$token" | fetch_existing "$ACTION" "$BUILD" "$PR" "${OWN_LOGIN:-}"

    # What the last run raised is in its own findings file. `fetch_previous` in lib.sh has
    # what that read needs and why it may come back empty.
    printf '%s' "$token" | fetch_previous "$ACTION" "$BUILD" "$PR"
fi

# The session reads its own copies, at the paths its prompts name. build-prompts.sh put the
# empty forms there; both fetches above write into the build directory, so the copies are
# taken again once they have run rather than being written twice.
cp "$BUILD/existing.json" "$BUILD/previous.json" "$SESSION/"

# Both fetches are done, and nothing this script runs from here on needs a credential. The
# reason is what comes after the session: `install: auto` puts `bun` on PATH with `npm
# install -g` under a prefix this user owns, and the action path holds the scripts a `bun` is
# pointed at, so a session with Bash has the length of a review to replace either one.
# Handing a token to one of them afterwards is handing it to code a lens chose. The refetch
# that used to happen here is the posting step's and the printing script's now, each of which
# holds a credential already, and the value goes out of this shell before an agent starts.
#
# What is left over is written down in "The GitHub token never enters the step that runs the
# agent" in review/DECISIONS.md. Moving the refetch narrows where the credential goes; it does
# not make the runner safe to hand one to twice.
token=""

# The session's exit code is kept and weighed at the end rather than stopping the script here,
# because extract-findings.ts writes what the run cost and what it was refused before it
# looks for findings, and a run that failed is the one those numbers matter most for.
SESSION_STATUS=0

# The files the session was handed, which are the whole of what it could have rewritten of
# what anything else once read. `diff.sh` and `diff-args` are between them the diff every lens
# read; `existing.json` and `previous.json` are the record its own suppressions are decided
# against. Each is a copy under `$SESSION`, and the original stays in the build directory,
# which no prompt names.
#
# This used to be one directory, so every one of those files had to be copied aside before the
# session, compared afterwards and put back, with the comparison and the restore sharing a
# list because doing either alone fails. Two directories cost one `cp` and leave nothing to
# put back. What the split does not buy is safety: `--plugin-dir` is handed the directory both
# of these sit under, and a lens with Bash runs as this user, so it reaches either. The
# comparison below reports a session copy that stopped matching the original, which means the
# lenses did not all read the same diff.
HANDED=(diff-args diff.sh existing.json previous.json)

# The build files something reads after the session, which nothing can fetch again.
# reviewed-commit.ts takes the commit the review is recorded against out of `diff-args`, and
# `readDispatched` reads `lenses.txt` for which lenses ran, which is what catches a lens that
# said nothing about itself. `existing.json` and `previous.json` are not here because they are
# replaced outright below.
RECORDED=(diff-args lenses.txt)

# Their digests, kept in this shell's own variables. A file of digests would be a file the
# session can rewrite alongside what it describes, and `cmp` against the session's copy is no
# better: the same session writes both, so identical replacements pass it in silence. What a
# lens cannot reach without ptrace on an ancestor is the memory of the process that started it.
#
# `shasum` because a runner and a developer's Mac both have that spelling and only one of them
# has `sha256sum`. Where it is missing, the check says so rather than comparing two empty
# strings, which a reader could not tell from nothing having changed.
digest() {
    (cd "$BUILD" && shasum -a 256 "$1")
}

RECORDED_BEFORE=()

if command -v shasum >/dev/null 2>&1; then
    for recorded in "${RECORDED[@]}"; do
        RECORDED_BEFORE+=("$(digest "$recorded")")
    done
else
    echo "no shasum on PATH, so what this run reads after the session goes unchecked." >&2
fi

# Where the run log goes while the session is running, which is nowhere the session can name.
#
# It was `$BUILD/run.json` for the length of the review. The shell holding the write descriptor
# stopped a lens corrupting the bytes claude wrote, but not a lens opening the same path with
# `O_APPEND` and leaving a background loop appending until the process exited. Trailing bytes
# fail the whole-file parse in `messagesOf`, the line-by-line fallback runs, and the last line
# whose `type` is `result` becomes the merged findings the review is built from, posted under the
# account that holds `pull-requests: write`. Every lens runs with `Bash` as this user, and
# `--plugin-dir` is handed the directory the build one sits under, so every lens could reach it.
#
# So the log is opened twice over, a reader and a writer, and then unlinked before the session
# starts. What is left is those descriptors, held by this shell, and no path at all: nothing to
# open with `O_APPEND`, and nothing for a lens that goes looking under `--plugin-dir` to find.
# What that does not close is /proc/<pid>/fd on Linux, which the token block above is written
# against as well: a lens is a descendant of the process whose stdout this is, so it can reach
# the descriptor through /proc and open it afresh. `messagesOf` refusing a log that holds two
# results is the half of this that does not rest on the path being gone.
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/codeferret-log.XXXXXX")
exec 9>"$LOG_DIR/run.json"
exec 8<"$LOG_DIR/run.json"
rm -f "$LOG_DIR/run.json"
rmdir "$LOG_DIR"

# WebFetch and WebSearch are denied for the reason scripts/build-lens-agents.ts gives for
# leaving them off every lens. Agent has to stay: STEP 1 of the orchestrator prompt
# dispatches every lens with it, and denying it leaves the run with nothing to merge.
#
# `--setting-sources user` keeps the reviewed tree out of the session's own configuration.
# The session starts in that tree, and a SessionStart hook declared there runs even under
# bypassPermissions. Plugins passed with --plugin-dir still load, so the lens agents are
# unaffected. "The reviewed tree does not configure the session" in review/DECISIONS.md has
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
) >&9 || SESSION_STATUS=$?

# The session is gone, so the log becomes a file again: a plain one, in the build directory,
# written by this shell out of a descriptor nothing else ever held. `rm -f` first, because a
# session that pre-created the path as a symbolic link would otherwise have this write through
# it. `run.json` is not in `RECORDED` because there is nothing to compare it against: this run
# wrote every byte of it after the session had exited.
exec 9>&-
rm -f "$BUILD/run.json"
cat <&8 >"$BUILD/run.json"
exec 8<&-

# What the build directory holds, against what the session was given. Nothing is copied back,
# because nothing downstream reads a session copy: this is the report, and it is worth having
# because a difference means that the lenses did not all read the same diff.
#
# Before the deletions below, so that `existing.json` is still the file the fetch wrote.
CHANGED=()

# `diff-args` is in both lists, and it is the one file a session can fail both checks with at
# once: the body then read "The review session changed diff-args, diff-args under it.", which
# is the one line telling a reader the lens list may be the session's own answer.
note_changed() {
    for seen in "${CHANGED[@]+"${CHANGED[@]}"}"; do
        if [ "$seen" = "$1" ]; then return 0; fi
    done

    CHANGED+=("$1")
}

for handed in "${HANDED[@]}"; do
    if ! cmp -s "$BUILD/$handed" "$SESSION/$handed" 2>/dev/null; then
        echo "$handed changed during the review, so what the session read is not what it was given." >&2
        note_changed "$handed"
    fi
done

# And the build copies nothing puts back, against the digests this shell took before the
# session. A difference here means the commit the review is recorded against, or which lenses
# this run reports as dispatched, is the session's own answer.
#
# The per-entry `:-`, and the `+` expansion further down: where the machine had no `shasum`
# every lookup is empty, and bash 3.2, which is what a Mac runs, reads `"${arr[@]}"` on an
# empty array as an unbound variable under `set -u`.
for at in "${!RECORDED[@]}"; do
    recorded=${RECORDED[$at]}
    before=${RECORDED_BEFORE[$at]:-}

    [ -n "$before" ] || continue

    if [ "$before" != "$(digest "$recorded")" ]; then
        echo "$recorded changed during the review, so what is read from here on is not what was built." >&2
        note_changed "$recorded"
    fi
done

# The orchestrator ran with Bash under bypassPermissions, so a directory no prompt names is
# still a directory it can list. Every file below decides something after the session has
# ended, and none of them is evidence unless the step that earns it wrote it during this run.
# So each path is cleared here, and what comes next puts it back or it does not.
#
# findings.json and findings-checked are what the action posts on. post-review.ts and
# print-findings.ts re-decide every suppression and every thread closure against
# existing.json and previous.json, so both are replaced with their empty forms, which reopens
# every suppression, and the first of the two to run calls `fetch_existing` and
# `fetch_previous` for copies taken after the session ended. The fetches are theirs rather than
# this script's because the token would have to come back into this shell to be used here, and
# lib.sh has the rest of that argument.
#
# `previous.json` is on this list for the same reason `existing.json` is: `vetSuppression`
# reads it through `filesRaisedBefore`, and that set is the whole of what settles an
# `already-reported` finding citing no comment, which orchestrator.md makes the ordinary case.
# The session held the path to its own copy in the same prompt as the rule, and the build copy
# is one directory along from it.
rm -f "$BUILD/findings.json" "$BUILD/findings-checked" "$BUILD/existing.json" "$BUILD/previous.json"
empty_existing "$BUILD/existing.json"
empty_previous "$BUILD/previous.json"

# What the build directory has to be before anything reads it again: nothing but plain files,
# and every number a run that reported none still writes down. `guardBuildDir` in
# review/finalise.ts does the sweep and `UNREPORTED` beside it holds the numbers.
$PREFIX bun --config=/dev/null "$ACTION/review/finalise.ts" prepare "$BUILD"

# Written down rather than only said, and the review still goes out. `readSessionChanged` in
# run-files.ts carries this into the posted body as a coverage warning, beside the one for a
# lens that reported nothing about itself, because a detection whose only output is stderr has
# no consumer: the reader those caveats are for never opens a job log.
#
# Not by clearing `findings-checked`, which is the other way to act on this and the wrong one.
# It would leave the run posting nothing at all, which is the failure the whole `warned` path
# exists to prevent, and it would hand a session that wanted its findings buried a one-line way
# to do it: rewrite an input this compares, and the review it was paid for is never posted.
#
# After the sweep above, so a file the session pre-created as a symbolic link is gone rather
# than written through, and truncated first, so nothing the session left in it stands either way.
: >"$BUILD/session-changed.txt"

for changed in "${CHANGED[@]+"${CHANGED[@]}"}"; do
    printf '%s\n' "$changed" >>"$BUILD/session-changed.txt"
done

# `-f` and not `-s`: a session killed before it wrote a byte leaves this file empty, and that
# is the run extract-findings.ts writes `none reported` and `unknown` for. Missing is a different
# case, since this shell writes the file itself out of a descriptor it held throughout, and
# `settle` ends the run red on it.
extracted=-

if [ -f "$BUILD/run.json" ]; then
    extracted=0

    $PREFIX bun --config=/dev/null "$ACTION/review/extract-findings.ts" \
        "$BUILD/run.json" "$BUILD/findings.json" || extracted=$?
fi

# The shape check runs whatever went wrong above, because the marker it writes is what the
# action posts on.
checked=-

if [ -f "$BUILD/findings.json" ]; then
    checked=0
    $PREFIX bun --config=/dev/null "$ACTION/review/check-findings.ts" "$BUILD/findings.json" || checked=$?
fi

# The session's exit, the extraction's, the shape check's and the marker, settled in one place.
status=0

$PREFIX bun --config=/dev/null "$ACTION/review/finalise.ts" settle \
    "$BUILD" "$SESSION_STATUS" "$extracted" "$checked" || status=$?

exit "$status"
