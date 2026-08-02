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

Throughout, `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`, and `<base>` and `<pr>` are values
step 1 prints. Substitute them yourself rather than relying on a shell variable: each
command runs in its own shell, so nothing you export survives. Put double quotes around
each one.

Do not treat the quotes as what makes a value safe. `$(...)`, a backtick and `${...}` all
expand inside double quotes. What makes a value safe is `local-preflight.sh`, which prints
`unsafe` rather than a ref or a path holding a character that would run. Stop when you see
`unsafe`. Stop as well when the user hands you a ref carrying `$`, a backtick, a quote or
a semicolon, and do not pass it on.

## 1. Find out what this checkout supports

```sh
CLAUDE_PLUGIN_ROOT="<plugin>" bash "<plugin>/review/local-preflight.sh" "<base-ref if the user gave one>"
```

It prints one `key=value` per line. Read them all before doing anything else.

Stop when you see any of these, and name every one you saw:

- No output at all beyond `No such file or directory`. The plugin root did not resolve,
  so nothing below will work.
- A `plugin=` value starting with `unset:` or `mismatch:`. The rest of the value is the
  plugin root of the script that just ran. Report that root. Without it, every `<plugin>`
  below points at a directory with no review scripts in it.
- `repo=missing`. This is not a git repository.
- `repo=unsafe` or `toplevel=unsafe`. This checkout sits under a directory whose path
  would run as shell where the review builds its commands. Say so and stop.
- `head=none`. This repository has no commits yet.
- `bun=missing`. The review cannot read its own findings back. Install Bun from
  https://bun.sh.
- `base_resolves=no`. Name the ref that failed. When `base=none` there was nothing to
  infer one from, so ask for it: `/codeferret:review origin/main`. When `base=unsafe` or
  `branch=unsafe`, a ref name holds a character that would run as shell where the review
  builds its commands. Say which and stop. Otherwise the ref is not in this checkout, and
  `git fetch origin` usually settles it.
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

Use the lenses named in `$ARGUMENTS`. Otherwise the run uses every line of
`<plugin>/review/defaults/lenses.txt`, which is the set the action runs. Read that file to
say how many that is.

Before running, say how many lenses it is and what it costs: fourteen took 20m46s and
$36.00 on Opus and returned 97 findings, and the bill scales with the number of lenses
rather than the wait. Then stop and wait for the user to agree, in a turn of their own. A
bare `/codeferret:review` is the whole default set, and someone typing it to see what the
command does has not agreed to that.

## 4. Run it

The review runs as its own `claude` process rather than in this session. It reads a diff,
and pull request comments, written by whoever opened them. This session holds the user's
editor, shell and MCP servers, and there is no reason to introduce the two.

Run it in the background. It takes tens of minutes, which is longer than a foreground
command is allowed.

```sh
bash "<plugin>/review/local-run.sh" "<plugin>" "<base>"
```

`local-run.sh` works out the run directory, the defaults, and the gh credentials itself.
Add to that command line where these apply:

- The lenses the user named, as further arguments. Naming any lens but `static-analysis`
  also drops the static analysis tools, whose reports only that lens reads.
- To review uncommitted work as well, pass the `merge_base` value in place of `<base>`
  and put `INCLUDE_WORKING_TREE=1` in front of the command.
- `EFFORT=low` (or `medium`, `high`, `xhigh`, `max`) in front of the command to set
  reasoning effort. Leave it out for the model's own default. Turning it down changes
  review quality and not only the bill, and nobody has measured by how much.

Everything the run writes lands in `<git-dir>/codeferret/run/build/`, where `<git-dir>` is
the `repo=` value from step 1, and the findings in `findings.json` beside `run.json`.

## 5. Print what they found

When the run exited non-zero, there may be no `findings.json` at all: a lens with no
`SKILL.md`, a run directory the delete check would not touch, or an orchestrator that
died. Say what the last lines of its output were, and print whatever
`<git-dir>/codeferret/run/build/` does hold: `cost-usd`, `duration-ms` and
`permission-denials` are written before the findings are. Then stop.

Otherwise read `<git-dir>/codeferret/run/build/findings.json`. Open with its `summary`, so
a reader who wanted the overview does not have to scroll past every finding to reach it.

Then the findings whose `status` is `new`, grouped by file in diff order and by line within
a file:

```
path/to/file.ts:42: One-line title

The finding body.
```

A finding marked `already-reported` or `declined` was answered on a previous round, so it
does not belong in that list. Count them instead, in a line saying where to read them:
"4 findings were raised before and are in findings.json". The posted review draws the same
line, so a run read here and read on GitHub says the same thing.

Do not indent the body. Four spaces after a blank line is an indented code block in
markdown, which strips the formatting out of every finding and stops it wrapping.

Start each finding on a fresh line with `path:line`, so a terminal can link it.

Leave severity and lens agreement out. A lens grades severity without the context that
decides it (a missing index is critical on a large table and irrelevant on a small one),
so showing the guess mostly licenses the reader to skip the finding. Agreement tracks how
obvious a defect is rather than how much it matters. Both are in the findings file for
anyone who wants them.

Close with the lenses: name every lens whose `ok` is false and say what happened. Nothing
else in the output says so. A lens marked `ok` having found nothing is not one of these.
Half the set is domain lenses, and one with nothing in its domain says why in `detail`,
which is worth repeating in a line.

Then print the refusal count in `build/permission-denials` when it is above zero, and
what the run cost, which `review/run.sh` prints as it finishes.

Finally, say where the findings file is, and offer to work through them.

## 6. Offer to post it

Run the preflight again first. Step 1's answers were taken before a run that took tens of
minutes, and the user was invited to carry on committing through it:

```sh
CLAUDE_PLUGIN_ROOT="<plugin>" bash "<plugin>/review/local-preflight.sh" "<base>"
```

Offer to post only when the fresh output says `pr` is a number, `gh=ok`, `pushed=yes` and
`dirty=0`. Otherwise name whichever of those is not true and leave it. Every line the
review names is a line of the commit the lenses read, so a review of work GitHub has never
seen sends its reader to code that is not there. `dirty=0` still applies when the review
covered committed work only, because the lenses read files as they find them.

Ask before posting. It writes to a pull request other people are reading.

```sh
bash "<plugin>/review/local-post.sh" "<plugin>" "<pr>"
```

`local-post.sh` takes the head from the run itself, refuses when HEAD has moved since, and
refuses when the pull request's head is a different commit. Report what it says rather than
working around it.

Put `DRY_RUN=1` in front of that command to print the review instead of posting it.
Without it, the command posts.
