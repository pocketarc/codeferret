#!/usr/bin/env bash
# Assemble the run's lens plugin and the orchestrator prompt.
#
# Agent definitions carry the base ref, so the plugin is per-run and cannot ship
# pre-built. Building it outside the workspace leaves the caller's tree untouched.
#
# EXCLUDE_PATHS (newline-separated globs) becomes a git pathspec on the diff each lens
# is given, so an excluded file is absent rather than merely discouraged.
#
# Lens names arrive on stdin, one per line.
#
# Usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace> [<lenses-file>]
set -euo pipefail

BASE=${1:?usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace>}
ACTION=${2:?missing action path}
PLUGIN=${3:?missing plugin output dir}
WORKSPACE=${4:?missing workspace}
LENSES_FILE=${5:-}

BUILD="$PLUGIN/build"

NAMESPACE=codeferret
MANIFEST="$ACTION/lenses/.claude-plugin/plugin.json"

if ! grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$NAMESPACE\"" "$MANIFEST"; then
    echo "plugin namespace '$NAMESPACE' does not match the name in $MANIFEST" >&2
    exit 1
fi

rm -rf "$PLUGIN"
mkdir -p "$PLUGIN/.claude-plugin" "$PLUGIN/agents" "$PLUGIN/skills" "$BUILD"

# Generated agents and bundled skills must share one plugin to share a namespace.
cp "$ACTION/lenses/.claude-plugin/plugin.json" "$PLUGIN/.claude-plugin/plugin.json"
if [ -d "$ACTION/lenses/skills" ]; then
    cp -R "$ACTION/lenses/skills/." "$PLUGIN/skills/"
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

SCHEMA=$(cat "$ACTION/review/lens-schema.json")
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
    if [ -f "$PLUGIN/skills/$lens/SKILL.md" ]; then
        skill_ref="$NAMESPACE:$lens"
    elif [ -f "$WORKSPACE/.claude/skills/$lens/SKILL.md" ]; then
        skill_ref="$lens"
    else
        echo "lens '$lens' has no SKILL.md in the action's bundled lenses or in" >&2
        echo "$WORKSPACE/.claude/skills/$lens/" >&2
        exit 1
    fi

    brief=$(sed -e "s|__SKILL__|$skill_ref|g" -e "s|__BASE__|$BASE|g" \
        -e "s|__PATHSPEC__|$PATHSPEC|g" "$ACTION/review/lens-brief.md")
    brief=${brief/__SCHEMA__/$SCHEMA}

    # One lens only: a rulebook given to every lens pulls them all toward the same
    # generalist read. review/README.md has the evidence.
    if [ "$lens" = "mattpocock-code-review" ] && [ -f "$WORKSPACE/REVIEW.md" ]; then
        brief="$brief

This repository documents its own review conventions in \`REVIEW.md\`. Read it and
treat it as a standards source alongside anything else you find. It is additional
context, never grounds for staying quiet about something it does not mention."
    fi

    {
        printf -- '---\n'
        printf 'name: %s\n' "$lens"
        printf 'description: Reviews the diff under the %s lens.\n' "$lens"
        printf -- '---\n\n'
        printf '%s\n' "$brief"
    } >"$PLUGIN/agents/$lens.md"

    printf -- '- `%s:%s`\n' "$NAMESPACE" "$lens" >>"$BUILD/lens-list.txt"
done

# sed's `r` reads the list in after the marker line and `d` removes the marker.
# Passing a multi-line value through `awk -v` instead breaks on BSD awk.
sed -e "s|__BASE__|$BASE|g" \
    -e "s|__EXISTING__|$BUILD/existing.json|g" \
    -e "/__LENS_LIST__/r $BUILD/lens-list.txt" \
    -e "/__LENS_LIST__/d" \
    "$ACTION/review/orchestrator.md" >"$BUILD/orchestrator.txt"

[ -f "$BUILD/existing.json" ] || printf '{"existing": []}\n' >"$BUILD/existing.json"

echo "built ${#LENSES[@]} lens(es): ${LENSES[*]}"
echo "  plugin: $PLUGIN"
echo "  prompt: $BUILD/orchestrator.txt"
