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
# Set PROMPTS_ONLY=1 to render the prompts and skip building the plugin. A Claude Code
# session already has the lenses loaded, so it needs the prompts and nothing else.
#
# Usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace> [<lenses-file>]
set -euo pipefail

BASE=${1:?usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace>}
ACTION=${2:?missing action path}
PLUGIN=${3:?missing plugin output dir}
WORKSPACE=${4:?missing workspace}
LENSES_FILE=${5:-}

BUILD="$PLUGIN/build"
PROMPTS_ONLY=${PROMPTS_ONLY:-}

NAMESPACE=codeferret
MANIFEST="$ACTION/.claude-plugin/plugin.json"

if ! grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$NAMESPACE\"" "$MANIFEST"; then
    echo "plugin namespace '$NAMESPACE' does not match the name in $MANIFEST" >&2
    exit 1
fi

rm -rf "$PLUGIN"
mkdir -p "$BUILD"

if [ -z "$PROMPTS_ONLY" ]; then
    # Agents and skills must share one plugin to share a namespace.
    mkdir -p "$PLUGIN/.claude-plugin" "$PLUGIN/agents" "$PLUGIN/skills"

    # The shipped manifest points `skills` at the repository's own layout, which is not
    # this one. All the run plugin needs from it is a name to namespace by.
    printf '{"name": "%s", "version": "0.0.0", "description": "CodeFerret run plugin."}\n' \
        "$NAMESPACE" >"$PLUGIN/.claude-plugin/plugin.json"
fi

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
while IFS= read -r glob; do
    glob=$(printf '%s' "$glob" | tr -d '[:space:]')
    [ -z "$glob" ] && continue
    [ -z "$PATHSPEC" ] && PATHSPEC="-- ."
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

        # Only what was asked for goes into the plugin. A lens with no agent and no
        # skill in there cannot be dispatched even by mistake, which is a guarantee the
        # `lenses` input is worth having on top of the list below.
        if [ -z "$PROMPTS_ONLY" ]; then
            cp "$ACTION/agents/$lens.md" "$PLUGIN/agents/$lens.md"
            cp -R "$ACTION/lenses/skills/$lens" "$PLUGIN/skills/$lens"
        fi

        printf -- '- `%s:%s`\n' "$NAMESPACE" "$lens" >>"$BUILD/lens-list.txt"
    elif [ -f "$WORKSPACE/.claude/skills/$lens/SKILL.md" ]; then
        # A lens the action does not bundle has no agent of its own, so the generic one
        # takes the skill name at dispatch instead.
        if [ -z "$PROMPTS_ONLY" ]; then
            cp "$ACTION/agents/lens.md" "$PLUGIN/agents/lens.md"
        fi

        {
            printf -- '- `%s:lens`\n' "$NAMESPACE"
            printf '  Also tell it: Load the `%s` skill and have at it.\n' "$lens"
        } >>"$BUILD/lens-list.txt"
    else
        echo "lens '$lens' has no SKILL.md in the action's bundled lenses or in" >&2
        echo "$WORKSPACE/.claude/skills/$lens/" >&2
        exit 1
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

# A two-dot range against a commit diffs the working tree, so uncommitted work is in
# scope; three dots against HEAD is committed work alone. The action only ever reviews
# what is pushed, but a session is usually looking at a branch that is still being
# written.
if [ -n "${INCLUDE_WORKING_TREE:-}" ]; then
    RANGE="$BASE"
else
    RANGE="$BASE...HEAD"
fi

# Indent the dispatch prompt so it reads as a block inside the orchestrator's prompt,
# leaving blank lines free of trailing whitespace.
sed -e "s|__BASE__|$BASE|g" -e "s|__RANGE__|$RANGE|g" -e "s|__PATHSPEC__|$PATHSPEC|g" \
    "$ACTION/review/lens-dispatch.md" |
    sed -e 's|^.|    &|' >"$BUILD/dispatch.txt"

sed -e "s|__BASE__|$BASE|g" \
    -e "s|__EXISTING__|$BUILD/existing.json|g" \
    -e "/__LENS_LIST__/r $BUILD/lens-list.txt" \
    -e "/__LENS_LIST__/d" \
    -e "/__DISPATCH__/r $BUILD/dispatch.txt" \
    -e "/__DISPATCH__/d" \
    "$ACTION/review/orchestrator.md" >"$BUILD/orchestrator.txt"

[ -f "$BUILD/existing.json" ] || printf '{"existing": []}\n' >"$BUILD/existing.json"

echo "built ${#LENSES[@]} lens(es): ${LENSES[*]}"
if [ -z "$PROMPTS_ONLY" ]; then
    echo "  plugin: $PLUGIN"
fi
echo "  prompt: $BUILD/orchestrator.txt"
