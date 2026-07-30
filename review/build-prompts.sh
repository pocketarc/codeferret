#!/usr/bin/env bash
# Assemble the run's lens plugin and the orchestrator prompt.
#
# The plugin is built in a temp directory rather than in the repository under review:
# each lens subagent needs the base ref baked into its prompt, so agent definitions
# are per-run and cannot ship pre-built. Building outside the workspace also keeps the
# calling repository's tree clean.
#
# A lens name resolves in one of two places:
#   - a skill bundled with the action, which loads namespaced as `codeferret:<name>`
#   - a skill in the calling repository's .claude/skills/, which loads as `<name>`
# So a repository can add its own lens without forking the action.
#
# Lens names arrive on stdin, one per line, so no JSON parser is needed on the runner.
#
# Usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace> [<lenses-file>]
#
# The orchestrator prompt is told where to find the comments an earlier run already
# posted, so it can mark findings that have been said before.
set -euo pipefail

BASE=${1:?usage: build-prompts.sh <base-ref> <action-path> <plugin-out-dir> <workspace>}
ACTION=${2:?missing action path}
PLUGIN=${3:?missing plugin output dir}
WORKSPACE=${4:?missing workspace}
LENSES_FILE=${5:-}

BUILD="$PLUGIN/build"

# Skills bundled in the plugin load under the plugin's own name. That name lives in
# the manifest, so it is checked here rather than assumed: a silent mismatch would
# make every bundled lens reference resolve to nothing.
NAMESPACE=codeferret
MANIFEST="$ACTION/lenses/.claude-plugin/plugin.json"

if ! grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$NAMESPACE\"" "$MANIFEST"; then
    echo "plugin namespace '$NAMESPACE' does not match the name in $MANIFEST" >&2
    exit 1
fi

rm -rf "$PLUGIN"
mkdir -p "$PLUGIN/.claude-plugin" "$PLUGIN/agents" "$PLUGIN/skills" "$BUILD"

# The bundled skills are copied in so that generated agents and bundled skills share
# one plugin, and therefore one namespace.
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

    brief=$(sed -e "s|__SKILL__|$skill_ref|g" -e "s|__BASE__|$BASE|g" "$ACTION/review/lens-brief.md")
    brief=${brief/__SCHEMA__/$SCHEMA}

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

# The fetch step writes this before the review runs. An empty list keeps the
# orchestrator's read from failing when there is no pull request context.
[ -f "$BUILD/existing.json" ] || printf '{"existing": []}\n' >"$BUILD/existing.json"

echo "built ${#LENSES[@]} lens(es): ${LENSES[*]}"
echo "  plugin: $PLUGIN"
echo "  prompt: $BUILD/orchestrator.txt"
