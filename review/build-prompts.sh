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
# Set RESOLVE_THREADS=0 where the review posts under somebody's own account rather than
# CodeFerret's, which is every run outside CI.
#
# Usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace> [<lenses-file>]
set -euo pipefail

BASE=${1:?usage: build-prompts.sh BASE_REF ACTION_PATH PLUGIN_OUT_DIR WORKSPACE [LENSES_FILE]}
ACTION=${2:?missing action path}
PLUGIN=${3:?missing plugin output dir}
WORKSPACE=${4:?missing workspace}
LENSES_FILE=${5:-}

BUILD="$PLUGIN/build"
RESOLVE_THREADS=${RESOLVE_THREADS:-1}

# For a containerised toolchain, where `command-prefix` is set and the action deliberately
# installs nothing on the runner. run.sh passes it through.
PREFIX=${PREFIX:-}

# shellcheck source=review/lib.sh
. "$ACTION/review/lib.sh"

if ! plain_ref "$BASE"; then
    echo "base ref '$BASE' is not a plain git ref" >&2
    exit 1
fi

NAMESPACE=codeferret
MANIFEST="$ACTION/.claude-plugin/plugin.json"

if [ ! -f "$MANIFEST" ]; then
    echo "no plugin manifest at $MANIFEST" >&2
    exit 1
fi

if ! grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$NAMESPACE\"" "$MANIFEST"; then
    echo "plugin namespace '$NAMESPACE' does not match the name in $MANIFEST" >&2
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
        echo "it looks like a run directory from before this check existed." >&2
        echo "delete it yourself and run again: rm -rf '$PLUGIN'" >&2
    fi

    exit 1
fi

rm -rf "$PLUGIN"

# Agents and skills must share one plugin to share a namespace.
mkdir -p "$BUILD" "$PLUGIN/.claude-plugin" "$PLUGIN/agents" "$PLUGIN/skills"

# Written first, so a run that dies halfway leaves a directory the next run may clear.
: >"$MARKER"

# The shipped manifest points `skills` at the repository's own layout, which is not this
# one. Only the name matters here.
printf '{"name": "%s", "version": "0.0.0", "description": "CodeFerret run plugin."}\n' \
    "$NAMESPACE" >"$PLUGIN/.claude-plugin/plugin.json"

LENSES=()
while IFS= read -r lens; do
    lens=$(printf '%s' "$lens" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -z "$lens" ] && continue

    if ! plain_name "$lens"; then
        echo "lens name '$lens' is not a plain name" >&2
        exit 1
    fi

    LENSES+=("$lens")
done < <(if [ -n "$LENSES_FILE" ]; then cat "$LENSES_FILE"; else cat; fi)

if [ "${#LENSES[@]}" -eq 0 ]; then
    echo "no lenses given" >&2
    exit 1
fi

: >"$BUILD/lens-list.txt"

# A positive pathspec comes first, because git treats a list of pure exclusions as
# matching nothing. It is `:(top)` rather than `.` because git resolves a pathspec
# against the process's own directory, and every lens runs diff.sh from wherever its
# session started. With `.`, a run started in a subdirectory reviews that subdirectory
# and says nothing about the rest of the change.
PATHSPEC_ARGS=()
while IFS= read -r glob; do
    glob=$(printf '%s' "$glob" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -z "$glob" ] && continue

    # The list reaches git as argv now, through the NUL-separated file written further
    # down, so there is no shell left for a quote to break out of. The check stays for
    # whatever consumes the list next.
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
done <<<"${EXCLUDE_PATHS:-}"

for lens in "${LENSES[@]}"; do
    if [ -f "$ACTION/lenses/skills/$lens/SKILL.md" ]; then
        if [ ! -f "$ACTION/agents/$lens.md" ]; then
            echo "lens '$lens' is bundled but has no agent." >&2
            echo "run: bun scripts/build-lens-agents.ts" >&2
            exit 1
        fi

        cp "$ACTION/agents/$lens.md" "$PLUGIN/agents/$lens.md"
        cp -R "$ACTION/lenses/skills/$lens" "$PLUGIN/skills/$lens"
    elif [ -f "$WORKSPACE/.claude/skills/$lens/SKILL.md" ]; then
        # A lens the action does not bundle gets an agent rendered for it here, naming
        # its skill the way a bundled lens's agent names its own. The alternative was a
        # generic agent plus a line of the orchestrator's prompt telling it which skill to
        # pass on, and a lens that never received that line reviewed under its name with
        # no skill loaded, which nothing downstream can tell from a real review.
        #
        # The agent body comes from lens-brief.md and is ours. The skill it loads is not:
        # it sits in the tree the pull request modified. So naming a workspace lens puts
        # that repository's .claude/skills/ inside the CI trust boundary, where any branch
        # can write the instructions for an agent that has Bash and runs in the job holding
        # the tokens. Bundled lenses carry no such exposure. Said on stderr because nothing
        # else in a run distinguishes an agent driven by branch-supplied text from one
        # driven by ours.
        echo "lens '$lens' is not bundled: its skill comes from $WORKSPACE/.claude/skills/$lens/," >&2
        echo "which is part of the tree under review." >&2

        $PREFIX bun "$ACTION/scripts/build-lens-agents.ts" --one "$lens" "$PLUGIN/agents/$lens.md"

        # The skill is copied in beside the agent rather than loaded where it lives: run.sh
        # passes `--setting-sources user`, which on 2.1.220 takes a project's own
        # .claude/skills/ out of the session's reach with everything else the reviewed tree
        # declares. Left there, every workspace lens would follow its agent's own
        # instruction to stop and return nothing. "A lens agent ships pre-built" in
        # review/README.md has what was measured.
        cp -R "$WORKSPACE/.claude/skills/$lens" "$PLUGIN/skills/$lens"
    else
        echo "lens '$lens' has no SKILL.md in the action's bundled lenses or in" >&2
        echo "$WORKSPACE/.claude/skills/$lens/" >&2
        exit 1
    fi

    printf -- '- `%s:%s`\n' "$NAMESPACE" "$lens" >>"$BUILD/lens-list.txt"
done

# The action only ever reviews what is pushed. A session is usually on a branch still
# being written, and INCLUDE_WORKING_TREE covers that.
#
# A review runs for twenty minutes and whoever started it is often still committing, so the
# range names a commit rather than HEAD. In CI both resolve to the same checked-out commit.
HEAD_SHA=$(git -C "$WORKSPACE" rev-parse HEAD 2>/dev/null || echo HEAD)

# Compared with 1 rather than tested for emptiness. The value is composed by a model
# following commands/review.md, so `INCLUDE_WORKING_TREE=0` is a spelling that turns up,
# and under a test for emptiness it would drop the HEAD pin above.
case ${INCLUDE_WORKING_TREE:-0} in
0) RANGE="$BASE...$HEAD_SHA" ;;
1) RANGE="$BASE" ;;
*)
    echo "INCLUDE_WORKING_TREE is '$INCLUDE_WORKING_TREE'; it takes 0 or 1" >&2
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
$PREFIX bun "$ACTION/scripts/render-prompt.ts" \
    "$ACTION/review/lens-dispatch.md" "$BUILD/dispatch.txt" \
    --indent 4 \
    "__BASE__=$BASE" \
    "__HEAD__=$HEAD_SHA" \
    "__RANGE__=$RANGE" \
    "__DIFF_SCRIPT__=$BUILD/diff.sh" \
    "__DIFF_ARGS__=$BUILD/diff-args"

# Only CodeFerret's own account can tell its threads from a person's. Anywhere else the
# review posts as whoever ran it, and closing a thread would take their words off the
# page along with everyone else's. The two policies are separate files rather than one
# followed by its retraction, so the prompt states a single policy either way.
if [ "$RESOLVE_THREADS" = "0" ]; then
    RESOLVE_FILE="$ACTION/review/resolve-none.md"
else
    RESOLVE_FILE="$ACTION/review/resolve-judge.md"
fi

$PREFIX bun "$ACTION/scripts/render-prompt.ts" \
    "$ACTION/review/orchestrator.md" "$BUILD/orchestrator.txt" \
    "__BASE__=$BASE" \
    "__HEAD__=$HEAD_SHA" \
    "__EXISTING__=$BUILD/existing.json" \
    "__PREVIOUS__=$BUILD/previous.json" \
    "__LENS_LIST__@$BUILD/lens-list.txt" \
    "__DISPATCH__@$BUILD/dispatch.txt" \
    "__RESOLVE__@$RESOLVE_FILE"

# The orchestrator reads both files whether or not there was a pull request to fetch
# anything from, and fetch-existing.ts and fetch-previous.ts overwrite them when there was.
# The keys have to be the ones STEP 3 names: a branch with no pull request is the ordinary
# case in a session, and an object with none of them reaches the step that decides what to
# suppress.
printf '{"threads": [], "conversation": []}\n' >"$BUILD/existing.json"
printf '{"findings": []}\n' >"$BUILD/previous.json"

echo "built ${#LENSES[@]} lens(es): ${LENSES[*]}"
echo "  plugin: $PLUGIN"
echo "  prompt: $BUILD/orchestrator.txt"
