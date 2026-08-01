#!/usr/bin/env bash
# Assemble the run's lens plugin and the orchestrator prompt.
#
# The plugin is built outside the workspace so the caller's tree stays untouched.
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

BASE=${1:?usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace>}
ACTION=${2:?missing action path}
PLUGIN=${3:?missing plugin output dir}
WORKSPACE=${4:?missing workspace}
LENSES_FILE=${5:-}

BUILD="$PLUGIN/build"
RESOLVE_THREADS=${RESOLVE_THREADS:-1}

# The base ref arrives from a workflow input or from whatever the caller typed, and it
# reaches a prompt that tells a lens to run `git log <base>..HEAD`. Git refs cannot hold
# any of what is missing from this set, so nothing legitimate is turned away. A leading
# `-` is barred separately: it is legal in a ref name and git would read it as an option.
case $BASE in
"" | -* | *[!A-Za-z0-9._/-]*)
    echo "base ref '$BASE' is not a plain git ref" >&2
    exit 1
    ;;
esac

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

rm -rf "$PLUGIN"

# Agents and skills must share one plugin to share a namespace.
mkdir -p "$BUILD" "$PLUGIN/.claude-plugin" "$PLUGIN/agents" "$PLUGIN/skills"

# The shipped manifest points `skills` at the repository's own layout, which is not this
# one. Only the name matters here.
printf '{"name": "%s", "version": "0.0.0", "description": "CodeFerret run plugin."}\n' \
    "$NAMESPACE" >"$PLUGIN/.claude-plugin/plugin.json"

LENSES=()
while IFS= read -r lens; do
    lens=$(printf '%s' "$lens" | tr -d '[:space:]')
    [ -n "$lens" ] && LENSES+=("$lens")
done < <(if [ -n "$LENSES_FILE" ]; then cat "$LENSES_FILE"; else cat; fi)

if [ "${#LENSES[@]}" -eq 0 ]; then
    echo "no lenses given" >&2
    exit 1
fi

: >"$BUILD/lens-list.txt"

# `-- .` first so the excludes attach to a positive pathspec; without it git treats a
# list of pure exclusions as matching nothing.
PATHSPEC=""
PATHSPEC_ARGS=()
while IFS= read -r glob; do
    glob=$(printf '%s' "$glob" | tr -d '[:space:]')
    [ -z "$glob" ] && continue

    # A glob reaches here from a workflow input and ends up in a prompt a lens is told
    # to run. Globs need none of these, and a single quote alone was enough to close the
    # quoting below and run whatever followed.
    case $glob in
    *[\'\"\;\$\`\\\&\|\<\>]*)
        echo "exclude path '$glob' contains a shell metacharacter" >&2
        exit 1
        ;;
    esac

    if [ "${#PATHSPEC_ARGS[@]}" -eq 0 ]; then
        PATHSPEC_ARGS+=("--" ".")
        PATHSPEC="-- ."
    fi
    PATHSPEC_ARGS+=(":(exclude)$glob")
    PATHSPEC="$PATHSPEC ':(exclude)$glob'"
done <<<"${EXCLUDE_PATHS:-}"

printf '%s' "$PATHSPEC" >"$BUILD/pathspec.txt"

for lens in "${LENSES[@]}"; do
    if [ -f "$ACTION/lenses/skills/$lens/SKILL.md" ]; then
        if [ ! -f "$ACTION/agents/$lens.md" ]; then
            echo "lens '$lens' is bundled but has no agent." >&2
            echo "run: bun scripts/build-lens-agents.ts" >&2
            exit 1
        fi

        # Only what was asked for goes into the plugin. The list below is only a prompt;
        # a lens whose agent and skill are both absent cannot be dispatched at all.
        cp "$ACTION/agents/$lens.md" "$PLUGIN/agents/$lens.md"
        cp -R "$ACTION/lenses/skills/$lens" "$PLUGIN/skills/$lens"

        printf -- '- `%s:%s`\n' "$NAMESPACE" "$lens" >>"$BUILD/lens-list.txt"
    elif [ -f "$WORKSPACE/.claude/skills/$lens/SKILL.md" ]; then
        # A lens the action does not bundle has no agent of its own, so the generic one
        # takes the skill name at dispatch instead.
        cp "$ACTION/agents/lens.md" "$PLUGIN/agents/lens.md"

        # Name the lens on the line too. Two of these would otherwise be the same entry
        # twice, and lens_health could not say which one came back empty.
        {
            printf -- '- `%s:lens`, running the `%s` lens. Call it `%s` in `lens_health`.\n' \
                "$NAMESPACE" "$lens" "$lens"
            printf '  Also tell it: Load the `%s` skill and have at it.\n' "$lens"
        } >>"$BUILD/lens-list.txt"
    else
        echo "lens '$lens' has no SKILL.md in the action's bundled lenses or in" >&2
        echo "$WORKSPACE/.claude/skills/$lens/" >&2
        exit 1
    fi

    # This lens reads tool reports rather than the diff, and where they are is per-run.
    if [ "$lens" = "static-analysis" ]; then
        {
            printf '  Also tell it: The static analysis reports for this run are the files\n'
            printf '  matching `%s/tool-*.json`. Read every one of them.\n' "$BUILD"
        } >>"$BUILD/lens-list.txt"
    fi

    # One lens only: a rulebook given to every lens pulls them all toward the same
    # generalist read. review/README.md has the evidence.
    if [ "$lens" = "mattpocock-code-review" ] && [ -f "$WORKSPACE/REVIEW.md" ]; then
        {
            printf '  Also tell it: This repository documents its own review conventions in\n'
            printf '  `REVIEW.md`. Read it and treat it as a standards source alongside anything\n'
            printf '  else you find. It is additional context, never grounds for staying quiet\n'
            printf '  about something it does not mention.\n'
        } >>"$BUILD/lens-list.txt"
    fi
done

# Naming a commit and nothing else diffs it against the working tree, so uncommitted work
# is in scope; a three-dot range covers committed work alone. The action only ever reviews
# what is pushed, but a session is usually looking at a branch still being written.
#
# Pin HEAD to the commit it is now. A review runs for twenty minutes and whoever started
# it is often still working: a lens found the tree moving under it mid-review and had to
# re-anchor its whole review against a snapshot it took itself. In CI this resolves to the
# same checked-out commit either way.
HEAD_SHA=$(git -C "$WORKSPACE" rev-parse HEAD 2>/dev/null || echo HEAD)

if [ -n "${INCLUDE_WORKING_TREE:-}" ]; then
    RANGE="$BASE"
else
    RANGE="$BASE...$HEAD_SHA"
fi

# The pathspec runs to several hundred characters. Handing it to the orchestrator as
# text means it retypes the whole thing once per lens, and a copy that loses an entry
# puts lockfiles and build output back into the diff without anything noticing. A script
# is copied by name instead.
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

# `&` and `|` mean something to sed's replacement, and a path or a glob may hold either.
sed_escape() {
    printf '%s' "$1" | sed -e 's/[|&\\]/\\&/g'
}

# Indent the dispatch prompt so it sits as a block inside the orchestrator's prompt.
# Matching `^.` rather than `^` keeps blank lines free of trailing whitespace.
sed -e "s|__BASE__|$(sed_escape "$BASE")|g" \
    -e "s|__HEAD__|$(sed_escape "$HEAD_SHA")|g" \
    -e "s|__DIFF_SCRIPT__|$(sed_escape "$BUILD/diff.sh")|g" \
    "$ACTION/review/lens-dispatch.md" |
    sed -e 's|^.|    &|' >"$BUILD/dispatch.txt"

sed -e "s|__BASE__|$(sed_escape "$BASE")|g" \
    -e "s|__EXISTING__|$(sed_escape "$BUILD/existing.json")|g" \
    -e "/__LENS_LIST__/r $BUILD/lens-list.txt" \
    -e "/__LENS_LIST__/d" \
    -e "/__DISPATCH__/r $BUILD/dispatch.txt" \
    -e "/__DISPATCH__/d" \
    "$ACTION/review/orchestrator.md" >"$BUILD/orchestrator.txt"

# Only CodeFerret's own account can tell its threads from a person's. Anywhere else the
# review posts as whoever ran it, and closing a thread would take their words off the
# page along with everyone else's.
if [ "$RESOLVE_THREADS" = "0" ]; then
    cat >>"$BUILD/orchestrator.txt" <<'NO_RESOLVE'

One correction to STEP 4: leave `resolve` empty and close nothing. This run comments
under a person's own account rather than CodeFerret's, so `mine` marks their threads as
well as yours and there is no way to tell them apart. Still say in `notes` which threads
you would have closed and why.
NO_RESOLVE
fi

[ -f "$BUILD/existing.json" ] || printf '{"existing": []}\n' >"$BUILD/existing.json"

echo "built ${#LENSES[@]} lens(es): ${LENSES[*]}"
echo "  plugin: $PLUGIN"
echo "  prompt: $BUILD/orchestrator.txt"
