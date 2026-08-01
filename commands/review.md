---
description: Review this repository's diff through CodeFerret's review lenses.
argument-hint: "[base-ref] [lens…]"
---

Review this repository's diff and print what the lenses find. Work through the steps in
order.

`$ARGUMENTS` holds what the user typed: a ref to diff against, then the lenses to run.
Both parts are optional, so decide by looking. A word is a lens when a directory of that
name sits under `<plugin>/lenses/skills/` or `.claude/skills/`, and the base ref
otherwise. `/codeferret:review caveman-review` names a lens, not a ref.

Throughout, `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`, and `<git-dir>`, `<toplevel>`,
`<base>`, `<head>` and `<pr>` come from step 1. Substitute them yourself rather than
relying on a shell variable: each command runs in its own shell, so nothing you export
survives.

## 1. Find out what this checkout supports

```sh
CLAUDE_PLUGIN_ROOT="<plugin>" bash "<plugin>/review/local-preflight.sh" <base-ref if the user gave one>
```

It prints one `key=value` per line. Read them all before doing anything else.

Stop, and say which line stopped you, when:

- `plugin=missing` — the plugin root did not resolve, so nothing below will work.
- `repo=missing` — this is not a git repository.
- `head=none` — this repository has no commits yet.
- `bun=missing` — the review cannot read its own findings back. Install Bun from
  https://bun.sh.
- `base_resolves=no` — name the ref that failed. When `base=none` there was nothing to
  infer one from, so ask for it: `/codeferret:review origin/main`. Otherwise the ref is
  not in this checkout, and `git fetch origin` usually settles it.
- `shallow=yes` — a shallow clone has no merge base to diff against. `git fetch
  --unshallow` fixes it, but the fetch goes to the network, so ask first.

Carry on, but say so, when `gh=missing` or `gh=unauthenticated`: nothing can be posted,
earlier comments cannot be read so findings already answered will be raised again, and
the base ref falls back to the default branch rather than a pull request's.

## 2. Settle what is under review

A `<base>...HEAD` diff covers committed work only. When `dirty` is not `0`, say how many
tracked files are uncommitted and ask which the user wants:

- **Committed work only** — the same diff the action would review.
- **Uncommitted work as well** — diffs the working tree against `merge_base`.

When `untracked` is not `0`, say that too, whichever they pick. A git diff never shows an
untracked file, so a newly written one is invisible to every lens until `git add -N
<path>` puts it in the index.

## 3. Settle the lenses

Use the lenses named in `$ARGUMENTS`. Otherwise use every line of
`<plugin>/review/defaults/lenses.txt`, which is the set the action runs.

Before running, say how many lenses that is and what it costs: the full twelve took 19
minutes and $31.80 on Opus over a 47-file diff, and the bill scales with the number of
lenses rather than the wait. Let the user stop you there.

## 4. Run it

The review runs as its own `claude` process rather than in this session. It reads a diff,
and pull request comments, written by whoever opened them; this session holds the user's
editor, shell and MCP servers, and there is no reason to introduce the two.

Run it in the background — it takes tens of minutes, which is longer than a foreground
command is allowed.

```sh
LENSES="$(cat "<plugin>/review/defaults/lenses.txt")" \
  EXCLUDE_PATHS="$(cat "<plugin>/review/defaults/exclude-paths.txt")" \
  MODEL=opus \
  PERMISSION_MODE=auto \
  RESOLVE_THREADS=0 \
  PR=<pr, or leave unset when there is none> \
  OWN_LOGIN="$(gh api user --jq .login)" \
  GITHUB_TOKEN="$(gh auth token)" \
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
  bash "<plugin>/review/run.sh" <base> "<plugin>" "<git-dir>/codeferret/run" <toplevel>
```

Set `LENSES` to the user's lenses instead when they named any, one per line.

To review uncommitted work as well, pass `merge_base` as `<base>` and add
`INCLUDE_WORKING_TREE=1`.

Leave the `PR`, `OWN_LOGIN`, `GITHUB_TOKEN` and `GITHUB_REPOSITORY` lines out entirely
when there is no open pull request or `gh` is unavailable. They are what lets the review
skip a finding somebody has already answered.

`PERMISSION_MODE=auto` lets a lens run the reads it needs and refuses the rest. The
action uses `bypassPermissions` because a runner is disposable and this machine is not.

Everything the run writes lands in `<git-dir>/codeferret/run/build/`, and the findings in
`findings.json` beside `run.json`.

## 5. Print what they found

Read `<git-dir>/codeferret/run/build/findings.json`. Group its findings by file, in diff
order, and by line within a file:

```
path/to/file.ts:42 — One-line title

    The finding body.
```

Keep `path:line` on its own so a terminal can link it.

Leave severity and lens agreement out. A lens grades severity without the context that
decides it — a missing index is critical on a large table and irrelevant on a small one
— so showing the guess mostly licenses the reader to skip. Agreement tracks how
conspicuous a defect is rather than how much it matters. Both are in the findings file
for anyone who wants them.

Close with the summary, and then the lenses: name every lens whose `ok` is false and say
what happened. A lens that returned nothing is more likely broken than satisfied, and
nothing else in the output says so. Say the same about anything in
`build/permission-denials` above zero, and about what the run cost, which
`review/run.sh` prints as it finishes.

Finally, say where the findings file is, and offer to work through them.

## 6. Offer to post it

Only when `pr` is a number, `gh=ok`, `pushed=yes` and `dirty=0`. Otherwise name whichever
of those is not true and leave it: comments are anchored to a commit GitHub holds, so a
review of work that GitHub has never seen lands on the wrong lines, or on none.

Ask before posting. It writes to a pull request other people are reading.

```sh
GITHUB_TOKEN="$(gh auth token)" \
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
  EXCLUDE_PATHS="$(cat "<plugin>/review/defaults/exclude-paths.txt")" \
  bun "<plugin>/review/post-review.ts" \
      "<git-dir>/codeferret/run/build/findings.json" <base> <head> <pr>
```

`EXCLUDE_PATHS` has to be the list the lenses were given, or a finding can anchor to a
file they never saw.

Add `DRY_RUN=1` to that environment to print the review instead of posting it. Without
it, the command posts.
