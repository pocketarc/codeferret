#!/usr/bin/env bash
# Assemble the run's lens plugin and the orchestrator prompt.
#
# The plugin is built outside the workspace so the caller's tree stays untouched.
#
# This clears the output directory, so anything else that writes into build/ has to run
# afterwards. fetch-existing.ts is the one that matters: run it first and its file is
# deleted, the orchestrator reads the empty placeholder written here, and every comment
# already on the pull request gets posted a second time.
#
# EXCLUDE_PATHS (newline-separated globs) becomes a git pathspec on the diff each lens
# is given, so an excluded file is absent from what they review.
#
# Lens names arrive on stdin, one per line.
#
# Set RESOLVE_THREADS=1 where the review posts under CodeFerret's own account, which is CI.
# Anywhere else the review is posted as whoever ran it.
#
# Usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace>
set -euo pipefail

BASE=${1:?usage: build-prompts.sh BASE_REF ACTION_PATH PLUGIN_OUT_DIR WORKSPACE}
ACTION=${2:?missing action path}
PLUGIN=${3:?missing plugin output dir}
WORKSPACE=${4:?missing workspace}

# Off unless the value is exactly `1`, which is the test post-review.ts makes. The two
# decide one thing between them: this script renders the prompt that asks the orchestrator
# which threads to close, and post-review.ts decides whether anything acts on the answer.
# Defaulting the other way here sent a by-hand run.sh through a step of the review whose
# output post-review.ts then refused, and the only sign was a line saying so at the end.
RESOLVE_THREADS=${RESOLVE_THREADS:-0}

# Absolute, because every `bun` below runs from the build directory rather than from the
# tree under review, where this script is started. Each one takes `--config=/dev/null` as
# well; the comment on `cd "$BUILD"` in run.sh has why both.
ACTION=$(cd "$ACTION" && pwd)

# For a containerised toolchain, where `command-prefix` is set and the action deliberately
# installs nothing on the runner. run.sh passes it through.
PREFIX=${PREFIX:-}

# shellcheck source=review/lib.sh
. "$ACTION/review/lib.sh"

run_dirs "$PLUGIN"
BUILD=$BUILD_DIR
SESSION=$SESSION_DIR

if ! plain_ref "$BASE"; then
    echo "base ref '$BASE' is not a plain git ref" >&2
    exit 1
fi

# The shape is not the same question as whether it is there. `action.yml` verifies the ref
# it works out, and nothing did on the path /codeferret:review and a by-hand run.sh take, so
# a base that does not resolve reached `git diff` and the run failed with git's own message
# after the prompts were built. review/lib.sh explains the flag `verify_ref` passes, and why.
if ! verify_ref "$WORKSPACE" "$BASE"; then
    echo "base ref '$BASE' does not resolve in $WORKSPACE" >&2
    exit 1
fi

# The namespace every `<namespace>:<lens>` dispatch is written under, out of the file
# scripts/build-defaults.ts generates from the plugin manifest.
NAMESPACE_FILE="$ACTION/review/defaults/namespace.txt"

if [ ! -f "$NAMESPACE_FILE" ]; then
    echo "no plugin namespace at $NAMESPACE_FILE" >&2
    echo "run: bun --config=/dev/null scripts/build-defaults.ts" >&2
    exit 1
fi

NAMESPACE=$(cat "$NAMESPACE_FILE")

# It becomes a path component, so it is held to the bar a lens name is held to.
if ! plain_name "$NAMESPACE"; then
    echo "plugin namespace '$NAMESPACE' in $NAMESPACE_FILE is not a plain name" >&2
    exit 1
fi

# /codeferret:review has a model paste the git dir into this argument by hand, so the
# recursive delete below can be pointed at a repository by a substitution that came back
# empty or truncated. Refuse any path this script did not write itself: the git dir, the
# working tree and a home directory all exist and none of them carries the marker.
MARKER="$BUILD/.codeferret-run"
DECLINE=""

case $PLUGIN in
/) DECLINE="is the root directory" ;;
/*) ;;
*) DECLINE="is not an absolute path" ;;
esac

if [ -z "$DECLINE" ] && [ -e "$PLUGIN" ] && [ ! -f "$MARKER" ]; then
    DECLINE="already exists and was not written by this script"
fi

if [ -n "$DECLINE" ]; then
    echo "will not delete '$PLUGIN': it $DECLINE" >&2

    if [ -d "$PLUGIN/build" ]; then
        echo "it has the shape of a run directory, so an earlier run probably left it." >&2
        echo "delete it yourself and run again: rm -rf '$PLUGIN'" >&2
    fi

    exit 1
fi

rm -rf "$PLUGIN"

# Agents and skills must share one plugin to share a namespace.
mkdir -p "$BUILD" "$SESSION" "$PLUGIN/.claude-plugin" "$PLUGIN/agents" "$PLUGIN/skills"

# Before anything that can exit, so a run that dies halfway leaves a directory the next run
# may clear. `prefix_reaches` below exits 1, and without the marker already down that exit
# leaves a plugin directory every later run refuses to touch.
: >"$MARKER"

# Here rather than beside run.sh's own call: the directory does not exist until the mkdir
# above, and the first `$PREFIX bun` below would create it inside the container and leave
# `test -d` answering yes about a path only the container has.
prefix_reaches "$BUILD"

# The shipped manifest points `skills` at the repository's own layout, which is not this
# one. Only the name matters here.
printf '{"name": "%s", "version": "0.0.0", "description": "CodeFerret run plugin."}\n' \
    "$NAMESPACE" >"$PLUGIN/.claude-plugin/plugin.json"

LENSES=()
while IFS= read -r lens; do
    if ! plain_name "$lens"; then
        echo "lens name '$lens' is not a plain name" >&2
        exit 1
    fi

    LENSES+=("$lens")
done < <(trim_lines)

if [ "${#LENSES[@]}" -eq 0 ]; then
    echo "no lenses given" >&2
    exit 1
fi

: >"$BUILD/lens-list.txt"
: >"$BUILD/lenses.txt"

# A positive pathspec comes first, because git treats a list of pure exclusions as
# matching nothing. It is `:(top)` rather than `.` because git resolves a pathspec
# against the process's own directory, and every lens runs diff.sh from wherever its
# session started. With `.`, a run started in a subdirectory reviews that subdirectory
# and says nothing about the rest of the change.
PATHSPEC_ARGS=()
while IFS= read -r glob; do
    # The list reaches git as argv, through the NUL-separated file written further down, so
    # no shell reads it on the way. The check is what keeps that true: a glob refused here
    # cannot be the one that turns up in a prompt or a command line the day somebody hands
    # the pathspec to something other than `git diff`.
    if ! plain_path "$glob"; then
        echo "exclude path '$glob' contains a shell metacharacter" >&2
        exit 1
    fi

    if [ "${#PATHSPEC_ARGS[@]}" -eq 0 ]; then
        PATHSPEC_ARGS+=("--" ":(top)")
    fi

    # `glob` magic, so a leading `**/` matches zero or more directories. Git matches a
    # bare pathspec with fnmatch, where `**/` still needs a `/` earlier in the path: the
    # default `**/.next/**` excludes `apps/web/.next/` and leaves the top-level `.next/`
    # in, which is where `next build` writes in a repository holding one app. Under glob
    # magic `out/**` and `build/**` stay anchored at the root, as they are meant to.
    PATHSPEC_ARGS+=(":(top,exclude,glob)$glob")
done < <(printf '%s\n' "${EXCLUDE_PATHS:-}" | trim_lines)

for lens in "${LENSES[@]}"; do
    if [ -f "$ACTION/lenses/skills/$lens/SKILL.md" ]; then
        # Copied, not rendered, though `--one` below would render the same file. A bundled
        # lens's agent is its system prompt, and a checked-in one is a file somebody reviewed
        # rather than something a CI job wrote for itself. validate-repo.ts fails on one that
        # is missing or no longer matches its generator, so nothing reaches this branch from a
        # tree that passed it.
        if [ ! -f "$ACTION/agents/$lens.md" ]; then
            echo "lens '$lens' is bundled but has no agent." >&2
            echo "run: bun --config=/dev/null scripts/build-lens-agents.ts" >&2
            exit 1
        fi

        cp "$ACTION/agents/$lens.md" "$PLUGIN/agents/$lens.md"
        cp -R "$ACTION/lenses/skills/$lens" "$PLUGIN/skills/$lens"
    elif [ -f "$WORKSPACE/.claude/skills/$lens/SKILL.md" ]; then
        # The agent body comes from lens-brief.md and is ours. The skill it loads is not:
        # it sits in the tree the pull request modified. So naming a workspace lens puts
        # that repository's .claude/skills/ inside the CI trust boundary, where anyone who
        # can push a branch can write the instructions for an agent that has Bash and runs
        # in the job holding the tokens. Bundled lenses carry no such exposure. Said on stderr
        # because nothing else in a run distinguishes an agent driven by branch-supplied
        # text from one driven by ours.
        echo "lens '$lens' is not bundled: its skill comes from $WORKSPACE/.claude/skills/$lens/," >&2
        echo "which is part of the tree under review." >&2

        (
            cd "$BUILD" &&
                $PREFIX bun --config=/dev/null "$ACTION/scripts/build-lens-agents.ts" \
                    --one "$lens" "$PLUGIN/agents/$lens.md"
        )

        # The skill is copied in beside the agent rather than loaded where it lives: run.sh
        # passes `--setting-sources user`, which on 2.1.220 takes a project's own
        # .claude/skills/ out of the session's reach with everything else the reviewed tree
        # declares. Left there, every workspace lens would follow its agent's own
        # instruction to stop and return nothing. "A lens agent ships pre-built" in
        # review/DECISIONS.md has what was measured.
        cp -R "$WORKSPACE/.claude/skills/$lens" "$PLUGIN/skills/$lens"
    else
        echo "lens '$lens' has no SKILL.md in the action's bundled lenses or in" >&2
        echo "$WORKSPACE/.claude/skills/$lens/" >&2
        exit 1
    fi

    # Twice, into two files. `lens-list.txt` is spliced into the orchestrator's prompt and its
    # decoration is prose; `lenses.txt` is what run-files.ts reads back, and the comment on
    # `DISPATCHED_FILE` says why one file could not be both.
    printf -- '- `%s:%s`\n' "$NAMESPACE" "$lens" >>"$BUILD/lens-list.txt"
    printf '%s:%s\n' "$NAMESPACE" "$lens" >>"$BUILD/lenses.txt"
done

# A review runs for twenty minutes and whoever started it is often still committing, so the
# range names a commit rather than HEAD. In CI both resolve to the same checked-out commit.
HEAD_SHA=$(git -C "$WORKSPACE" rev-parse HEAD 2>/dev/null || echo HEAD)

# A model following commands/review.md composes this value, and writes `INCLUDE_WORKING_TREE=0`
# rather than leaving it out. So the test is on the value: one that asked whether the
# variable was set at all would read that `0` as on, and drop the HEAD pin above.
case ${INCLUDE_WORKING_TREE:-0} in
0) RANGE="$BASE...$HEAD_SHA" ;;
1) RANGE="$BASE" ;;
*)
    echo "INCLUDE_WORKING_TREE is '$INCLUDE_WORKING_TREE'. It has to be 0 or 1." >&2
    exit 1
    ;;
esac

# The pathspec runs to several hundred characters. Handing it to the orchestrator as
# text means it retypes the whole thing once per lens, and a copy that loses an entry
# puts lockfiles and build output back into the diff without anything noticing. The
# orchestrator passes the script's path instead, so nothing retypes the pathspec.
#
# The arguments go beside the script rather than into it, NUL-separated. Writing them
# into the script body made every one of them shell, and every lens is told to run it.
printf '%s\0' "$RANGE" ${PATHSPEC_ARGS[@]+"${PATHSPEC_ARGS[@]}"} >"$BUILD/diff-args"

cat >"$BUILD/diff.sh" <<'DIFF_SCRIPT'
#!/usr/bin/env bash
# The diff this run reviews. Rebuilt every run.
set -euo pipefail
args=()
while IFS= read -r -d '' arg; do args+=("$arg"); done <"$(dirname "$0")/diff-args"
git diff "${args[@]}"
DIFF_SCRIPT

# The dispatch prompt is indented so that it sits as a block inside the orchestrator's.
#
# Every path named in a prompt is under `$SESSION`, and the copies there are written at the
# end of this script. Nothing downstream reads one: the originals stay in `$BUILD`, which no
# prompt names and which is where the run's own record of what the lenses read is taken from.
(
    cd "$BUILD" &&
        $PREFIX bun --config=/dev/null "$ACTION/scripts/render-prompt.ts" \
            "$ACTION/review/lens-dispatch.md" "$BUILD/dispatch.txt" \
            --indent 4 \
            "__BASE__=$BASE" \
            "__HEAD__=$HEAD_SHA" \
            "__RANGE__=$RANGE" \
            "__DIFF_SCRIPT__=$SESSION/diff.sh" \
            "__DIFF_ARGS__=$SESSION/diff-args"
)

# Only CodeFerret's own account can tell its threads from a person's. Anywhere else the
# review is posted as whoever ran it, and closing a thread would take their words off the
# page along with everyone else's.
if [ "$RESOLVE_THREADS" = "1" ]; then
    RESOLVE_FILE="$ACTION/review/resolve-judge.md"
else
    RESOLVE_FILE="$ACTION/review/resolve-none.md"
fi

(
    cd "$BUILD" &&
        $PREFIX bun --config=/dev/null "$ACTION/scripts/render-prompt.ts" \
            "$ACTION/review/orchestrator.md" "$BUILD/orchestrator.txt" \
            "__BASE__=$BASE" \
            "__HEAD__=$HEAD_SHA" \
            "__EXISTING__=$SESSION/existing.json" \
            "__PREVIOUS__=$SESSION/previous.json" \
            "__LENS_LIST__@$BUILD/lens-list.txt" \
            "__DISPATCH__@$BUILD/dispatch.txt" \
            "__RESOLVE__@$RESOLVE_FILE"
)

# The orchestrator reads both files whether or not there was a pull request to fetch
# anything from, and fetch-existing.ts and fetch-previous.ts overwrite them when there was. A
# branch with no pull request is the ordinary case in a session, so the empty form reaches
# the step that decides what to suppress on most runs of `/codeferret:review`.
empty_existing "$BUILD/existing.json"
empty_previous "$BUILD/previous.json"

# The files the session opens while it runs, copied to the paths the prompts above name.
# `diff.sh` and `diff-args` are copied together because the script reads its arguments from
# beside itself. run.sh copies the two json files again once the fetches have rewritten them.
#
# The copies are what leaves everything in `$BUILD` readable as the run's own record. Neither
# `lens-list.txt` nor `orchestrator.txt` is here, because the prompts splice their contents
# rather than naming them, so the session never opens either.
cp "$BUILD/diff-args" "$BUILD/diff.sh" "$BUILD/existing.json" "$BUILD/previous.json" "$SESSION/"

echo "built ${#LENSES[@]} lens(es): ${LENSES[*]}"
echo "  plugin: $PLUGIN"
echo "  prompt: $BUILD/orchestrator.txt"
