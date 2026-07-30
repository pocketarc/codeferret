#!/usr/bin/env bash
# Vendor one upstream skill into lenses/skills/ at a pinned commit.
#
# Skills are vendored rather than fetched at run time: a review job holds a
# `pull-requests: write` token, so what it executes should be reviewable and should not
# change between runs.
#
# The local name becomes the directory name, and the skill's frontmatter `name` is
# rewritten to match. All bundled lenses share one plugin namespace, and more than one
# upstream ships a skill called `security-review`.
#
# Usage: scripts/vendor-lens.sh <repo> <commit-sha> <in-repo-subdir> <local-name>
set -euo pipefail

REPO=${1:?usage: vendor-lens.sh <repo> <commit-sha> <in-repo-subdir> <local-name>}
SHA=${2:?missing commit sha}
SUBDIR=${3:?missing in-repo subdir}
NAME=${4:?missing local name}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/lenses/skills/$NAME"
PROVENANCE="$ROOT/lenses/skills/PROVENANCE.tsv"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -sSfL -o "$WORK/skill.tar.gz" "https://codeload.github.com/$REPO/tar.gz/$SHA"

# codeload prefixes every entry with <reponame>-<sha>/, so strip that plus the in-repo
# path to land the skill's contents flat in lenses/skills/<name>/.
PREFIX=$(tar -tzf "$WORK/skill.tar.gz" | sed -n '1p' | cut -d/ -f1)
DEPTH=$((2 + $(printf '%s' "$SUBDIR" | tr -cd '/' | wc -c | tr -d ' ')))

rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$WORK/skill.tar.gz" -C "$DEST" --strip-components="$DEPTH" "$PREFIX/$SUBDIR"

if [ ! -f "$DEST/SKILL.md" ]; then
    echo "no SKILL.md at $SUBDIR in $REPO@$SHA" >&2
    rm -rf "$DEST"
    exit 1
fi

bun "$ROOT/scripts/prepare-skill.ts" "$DEST/SKILL.md" "$NAME"

if [ ! -s "$PROVENANCE" ]; then
    printf 'local_name\trepo\tcommit\tsubdir\n' >"$PROVENANCE"
fi

# Replace any existing row for this lens so re-vendoring updates rather than duplicates.
grep -v "^$NAME	" "$PROVENANCE" >"$WORK/provenance" || true
printf '%s\t%s\t%s\t%s\n' "$NAME" "$REPO" "$SHA" "$SUBDIR" >>"$WORK/provenance"
head -n 1 "$WORK/provenance" >"$PROVENANCE"
tail -n +2 "$WORK/provenance" | sort >>"$PROVENANCE"

echo "vendored $NAME <- $REPO@${SHA:0:12} /$SUBDIR ($(find "$DEST" -type f | wc -l | tr -d ' ') files)"
