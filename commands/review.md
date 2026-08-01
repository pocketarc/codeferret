---
description: Review this repository's diff through CodeFerret's review lenses.
argument-hint: "[base-ref] [lens...]"
---

Review this repository's diff and print what the lenses find. Work through the steps in
order.

`$ARGUMENTS` holds what the user typed: a ref to diff against, then the lenses to run.
Both parts are optional, so decide by looking. A word is a lens when a directory of that
name sits under `<plugin>/lenses/skills/` or `.claude/skills/`, and the base ref
otherwise. `/codeferret:review caveman-review` names a lens, not a ref.

Throughout, `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`, and the rest come from step 1.
`<toplevel>`, `<base>`, `<head>` and `<pr>` are the values of the keys they name;
`<git-dir>` is the value of `repo=`. Substitute them yourself rather than relying on a
shell variable: each command runs in its own shell, so nothing you export survives.

Put double quotes around every one of them when you do. `<base>` in particular is
whatever the user typed, and it lands on a command line before anything gets to check it.
`build-prompts.sh` rejects a ref that is not a plain one, but only once the shell has
already run what you wrote.

## 1. Find out what this checkout supports

```sh
CLAUDE_PLUGIN_ROOT="<plugin>" bash "<plugin>/review/local-preflight.sh" "<base-ref if the user gave one>"
```

It prints one `key=value` per line. Read them all before doing anything else.

Stop when you see any of these, and name every one you saw:

- No output at all beyond `No such file or directory`. The plugin root did not resolve,
  so nothing below will work.
- A `plugin=` value starting with `unset:` or `mismatch:`. The rest of that value is the
  plugin root the script you just ran sits in, so say it: otherwise every `<plugin>` you
  substitute below comes from a root holding none of the review scripts, or from nothing.
- `repo=missing`. This is not a git repository.
- `head=none`. This repository has no commits yet.
- `bun=missing`. The review cannot read its own findings back. Install Bun from
  https://bun.sh.
- `base_resolves=no`. Name the ref that failed. When `base=none` there was nothing to
  infer one from, so ask for it: `/codeferret:review origin/main`. Otherwise the ref is
  not in this checkout, and `git fetch origin` usually settles it.
- `shallow=yes`. A shallow clone has no merge base to diff against. `git fetch
  --unshallow` fixes it, but the fetch goes to the network, so ask first.
- `merge_base=none`. `<base>` and `HEAD` share no history, which is what a grafted or
  filtered clone looks like too. Both diffs below are taken against the merge base, so
  there is nothing for a lens to read.

Carry on, but say so, when `gh=missing` or `gh=unauthenticated`: nothing can be posted,
earlier comments cannot be read so findings already answered will be raised again, and
the base ref falls back to the default branch rather than a pull request's.

## 2. Settle what is under review

A `<base>...HEAD` diff covers committed work only. When `dirty` is not `0`, say how many
tracked files are uncommitted and ask which the user wants:

- Committed work only: the same diff the action would review.
- Uncommitted work as well: the working tree diffed against `merge_base`.

When `untracked` is not `0`, say that too, whichever they pick. A git diff never shows an
untracked file, so a newly written one is invisible to every lens until `git add -N
<path>` puts it in the index.

Committed work is pinned to the commit HEAD is at when the run starts, so the user can
carry on committing while it runs. Uncommitted work cannot be: the lenses read the tree
as they go, and editing under them means they review different files from each other.
Say so if they pick it.

## 3. Settle the lenses

Use the lenses named in `$ARGUMENTS`. Otherwise use every line of
`<plugin>/review/defaults/lenses.txt`, which is the set the action runs.

Before running, say how many lenses that is and what it costs: twelve took 19 minutes and
$31.80 on Opus over a 47-file diff, and the bill scales with the number of lenses rather
than the wait. Then stop and wait for the user to agree, in a turn of their own. A bare
`/codeferret:review` is the whole default set, and someone typing it to see what the
command does has not agreed to that.

## 4. Run it

The review runs as its own `claude` process rather than in this session. It reads a diff,
and pull request comments, written by whoever opened them; this session holds the user's
editor, shell and MCP servers, and there is no reason to introduce the two.

Run it in the background. It takes tens of minutes, which is longer than a foreground
command is allowed.

Change the command below where these apply:

- When the user named lenses, set `LENSES` to those instead, one per line.
- To review uncommitted work as well, pass the `merge_base` value in place of `<base>`
  and add `INCLUDE_WORKING_TREE=1`.
- When `pr` is `none`, or `gh` is unavailable, leave the `PR`, `OWN_LOGIN`,
  `GITHUB_TOKEN` and `GITHUB_REPOSITORY` lines out entirely. Without them, the review
  cannot skip a finding somebody has already answered.

```sh
LENSES="$(cat "<plugin>/review/defaults/lenses.txt")" \
  EXCLUDE_PATHS="$(cat "<plugin>/review/defaults/exclude-paths.txt")" \
  TOOLS="$(cat "<plugin>/review/defaults/tools.txt")" \
  MODEL=opus \
  PERMISSION_MODE=auto \
  RESOLVE_THREADS=0 \
  PR="<pr>" \
  OWN_LOGIN="$(gh api user --jq .login)" \
  GITHUB_TOKEN="$(gh auth token)" \
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
  bash "<plugin>/review/run.sh" "<base>" "<plugin>" "<git-dir>/codeferret/run" "<toplevel>"
```

Under `PERMISSION_MODE=auto`, Claude Code's permission classifier passes the reads a lens
needs and refuses the rest. The action uses `bypassPermissions` because a runner is
disposable and this machine is not.

Everything the run writes lands in `<git-dir>/codeferret/run/build/`, and the findings in
`findings.json` beside `run.json`.

## 5. Print what they found

Read `<git-dir>/codeferret/run/build/findings.json`. Group its findings by file, in diff
order, and by line within a file:

```
path/to/file.ts:42: One-line title

The finding body.
```

Do not indent the body. Four spaces after a blank line is an indented code block in
markdown, which strips the formatting out of every finding and stops it wrapping.

Start each finding on a fresh line with `path:line`, so a terminal can link it.

Leave severity and lens agreement out. A lens grades severity without the context that
decides it (a missing index is critical on a large table and irrelevant on a small one),
so showing the guess mostly licenses the reader to skip the finding. Agreement tracks how
obvious a defect is rather than how much it matters. Both are in the findings file for
anyone who wants them.

Close with the summary, and then the lenses: name every lens whose `ok` is false and say
what happened. Nothing else in the output says so. A lens marked `ok` having found
nothing is not one of these. Half the set is domain lenses, and one with nothing in its
domain says why in `detail`, which is worth repeating in a line.

Then print the refusal count in `build/permission-denials` when it is above zero, and
what the run cost, which `review/run.sh` prints as it finishes.

Finally, say where the findings file is, and offer to work through them.

## 6. Offer to post it

Only when `pr` is a number, `gh=ok`, `pushed=yes` and `dirty=0`. Otherwise name whichever
of those is not true and leave it: comments are anchored to a commit GitHub holds, so a
review of work that GitHub has never seen lands on the wrong lines, or on none. `dirty=0`
still applies when the review covered committed work only. The lenses read files as they
find them, so the lines they report might not be the pushed commit's.

Ask before posting. It writes to a pull request other people are reading.

```sh
GITHUB_TOKEN="$(gh auth token)" \
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
  EXCLUDE_PATHS="$(cat "<plugin>/review/defaults/exclude-paths.txt")" \
  bun "<plugin>/review/post-review.ts" \
      "<git-dir>/codeferret/run/build/findings.json" "<base>" "<head>" "<pr>"
```

`<base>` here is always the ref step 1 reported, even when step 4 used `merge_base`.
`post-review.ts` anchors against `<base>...<head>`, which is the diff GitHub holds.

`EXCLUDE_PATHS` has to be the list the lenses were given, or a finding can anchor to a
file they never saw.

Add `DRY_RUN=1` to that environment to print the review instead of posting it. Without
it, the command posts.
