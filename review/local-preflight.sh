#!/usr/bin/env bash
# Report what a review driven from a Claude Code session can and cannot do.
#
# The action is handed its base ref, pull request number and head sha by the workflow
# event. A session has none of that and has to work them out from the checkout, so this
# reports up front which ones it could not, rather than failing tens of minutes and tens
# of dollars into a review.
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

# Every value below reaches a command line, because /codeferret:review has a model
# substitute them into the shell it runs. Quoting is no defence: `$(...)`, backticks and
# `${...}` all still expand inside double quotes. And a hostile value need not be typed by
# the user. `git check-ref-format` allows `$`, `(`, `)`, a backtick, `;`, `&` and `|`, so
# `gh pr view --json baseRefName` can hand back a branch name that runs on substitution.
#
# So a value that is not a plain git ref never gets printed. This is the same test
# build-prompts.sh applies, made one process earlier, before a shell has seen it.
plain_ref() {
    case $1 in
    "" | -* | *[!A-Za-z0-9._/-]*) return 1 ;;
    *) return 0 ;;
    esac
}

# This script lives in the plugin, so a root that did not resolve means bash never found
# it and none of this ran. What can go wrong is the caller holding a different path from
# the one it is reading, which every later command would then be built from. So say where
# the script actually is and let the caller compare.
ACTUAL_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    say plugin "unset:$ACTUAL_ROOT"
elif [ ! -f "$CLAUDE_PLUGIN_ROOT/review/build-prompts.sh" ]; then
    say plugin "mismatch:$ACTUAL_ROOT"
else
    say plugin ok
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

if [ -n "$BRANCH" ] && ! plain_ref "$BRANCH"; then
    say branch unsafe
    say base none
    say base_resolves no
    echo "the current branch name is not a plain git ref, so nothing here can be built into a command" >&2
    exit 0
fi

say branch "${BRANCH:-detached}"

if git remote get-url origin >/dev/null 2>&1; then
    say origin ok
else
    say origin missing
fi

# A shallow clone has no merge base to diff against, and deepening it is a network
# fetch, which is the caller's decision to make rather than this script's. Ask git; the
# marker file lives in the common dir in a linked worktree, not the one
# --absolute-git-dir reports.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
    say shallow yes
else
    say shallow no
fi

# Untracked files cannot appear in any diff, so they say nothing about whether the
# review is anchorable. Counting them as dirty would block posting over a scratch file.
say dirty "$(git status --porcelain --untracked-files=no | wc -l | tr -d '[:space:]')"
say untracked "$(git ls-files --others --exclude-standard | wc -l | tr -d '[:space:]')"

PR=""
PR_BASE=""
PR_HEAD=""

if command -v gh >/dev/null 2>&1; then
    # `gh pr view` answers with the closed or merged pull request a branch used to have,
    # which would offer to post a review onto something nobody is reading any more.
    PR_LINE=$(gh pr view --json number,baseRefName,headRefOid,state \
        --jq 'select(.state == "OPEN") | [.number, .baseRefName, .headRefOid] | @tsv' 2>/dev/null || true)
    PR=$(printf '%s' "$PR_LINE" | cut -f1)
    PR_BASE=$(printf '%s' "$PR_LINE" | cut -f2)
    PR_HEAD=$(printf '%s' "$PR_LINE" | cut -f3)
fi

say pr "${PR:-none}"

# The question is whether GitHub holds this commit, because that is what a review's
# comments anchor to, so ask the pull request when there is one. `origin/<branch>` only
# moves on a fetch or on a push from this clone: it says no to work pushed from another
# machine or the web UI, and yes to a commit a force-push elsewhere has already taken
# away, which posts a review that 422s on every comment at once.
REMOTE_HEAD=""

if [ -n "$PR_HEAD" ]; then
    REMOTE_HEAD="$PR_HEAD"
elif UPSTREAM=$(git rev-parse --verify --quiet '@{upstream}' 2>/dev/null); then
    REMOTE_HEAD="$UPSTREAM"
elif [ -n "$BRANCH" ]; then
    REMOTE_HEAD=$(git rev-parse --verify --quiet "origin/$BRANCH" 2>/dev/null || true)
fi

if [ -n "$REMOTE_HEAD" ] && [ "$HEAD_SHA" = "$REMOTE_HEAD" ]; then
    say pushed yes
else
    say pushed no
fi

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

if ! plain_ref "$BASE"; then
    say base unsafe
    say base_resolves no
    echo "base ref '$BASE' is not a plain git ref" >&2
    exit 0
fi

say base "$BASE"

if git rev-parse --verify --quiet "$BASE" >/dev/null; then
    say base_resolves yes

    # Unrelated histories have no merge base: a fresh repository with a remote added
    # afterwards, or a grafted, shallow or filtered clone. Reporting that as an empty
    # value gets it passed straight through as a base ref, and `git diff` given no range
    # compares the working tree against the index instead of against the branch point.
    say merge_base "$(git merge-base "$BASE" HEAD 2>/dev/null || echo none)"
else
    say base_resolves no
fi
