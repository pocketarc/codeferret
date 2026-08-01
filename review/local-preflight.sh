#!/usr/bin/env bash
# Report what a review driven from a Claude Code session can and cannot do.
#
# The action is handed its base ref, pull request number and head sha by the workflow
# event. A session has none of that and has to work them out from the checkout, so this
# reports up front which ones it could not, rather than failing sixteen minutes and
# several dollars into a review.
#
# Output is one key=value per line. A key whose value is `missing` or `no` is not an
# error: most of them only rule out posting.
#
# Usage: local-preflight.sh [<base-ref>]
set -uo pipefail

WANTED_BASE=${1:-}

say() {
    printf '%s=%s\n' "$1" "$2"
}

if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/review/build-prompts.sh" ]; then
    say plugin ok
else
    say plugin missing
fi

if command -v bun >/dev/null 2>&1; then
    say bun ok
else
    say bun missing
fi

if ! command -v gh >/dev/null 2>&1; then
    say gh missing
elif gh auth status >/dev/null 2>&1; then
    say gh ok
else
    say gh unauthenticated
fi

GIT_DIR=$(git rev-parse --absolute-git-dir 2>/dev/null || true)

if [ -z "$GIT_DIR" ]; then
    say repo missing
    exit 0
fi

say repo "$GIT_DIR"

# The git dir is not the working tree, and it is the working tree that holds
# .claude/skills/ and REVIEW.md. In a linked worktree the two are nowhere near
# each other.
say toplevel "$(git rev-parse --show-toplevel)"

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || true)

if [ -z "$HEAD_SHA" ]; then
    say head none
    exit 0
fi

say head "$HEAD_SHA"

BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
say branch "${BRANCH:-detached}"

if git remote get-url origin >/dev/null 2>&1; then
    say origin ok
else
    say origin missing
fi

# A shallow clone has no merge base to diff against, and deepening it is a network
# fetch, which is the caller's decision to make rather than this script's. Ask git
# rather than looking for the marker file: in a linked worktree it lives in the common
# dir, not the one --absolute-git-dir reports.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
    say shallow yes
else
    say shallow no
fi

# Untracked files cannot appear in any diff, so they say nothing about whether the
# review is anchorable. Counting them as dirty would block posting over a scratch file.
say dirty "$(git status --porcelain --untracked-files=no | wc -l | tr -d '[:space:]')"
say untracked "$(git ls-files --others --exclude-standard | wc -l | tr -d '[:space:]')"

if [ -n "$BRANCH" ] &&
    git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null &&
    [ "$HEAD_SHA" = "$(git rev-parse "origin/$BRANCH")" ]; then
    say pushed yes
else
    say pushed no
fi

PR=""
PR_BASE=""

if command -v gh >/dev/null 2>&1; then
    # `gh pr view` answers with the closed or merged pull request a branch used to have,
    # which would offer to post a review onto something nobody is reading any more.
    PR_LINE=$(gh pr view --json number,baseRefName,state \
        --jq 'select(.state == "OPEN") | [.number, .baseRefName] | @tsv' 2>/dev/null || true)
    PR=$(printf '%s' "$PR_LINE" | cut -f1)
    PR_BASE=$(printf '%s' "$PR_LINE" | cut -f2)
fi

say pr "${PR:-none}"

DEFAULT=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
DEFAULT=${DEFAULT#origin/}

if [ -z "$DEFAULT" ] && command -v gh >/dev/null 2>&1; then
    DEFAULT=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)
fi

say default_branch "${DEFAULT:-unknown}"

if [ -n "$WANTED_BASE" ]; then
    BASE="$WANTED_BASE"
elif [ -n "$PR_BASE" ]; then
    BASE="origin/$PR_BASE"
elif [ -n "$DEFAULT" ]; then
    BASE="origin/$DEFAULT"
else
    BASE=""
fi

if [ -z "$BASE" ]; then
    say base none
    say base_resolves no
    exit 0
fi

say base "$BASE"

if git rev-parse --verify --quiet "$BASE" >/dev/null; then
    say base_resolves yes
    say merge_base "$(git merge-base "$BASE" HEAD 2>/dev/null || true)"
else
    say base_resolves no
fi
