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

Quoting is not what makes a substituted value safe, so do not treat it as though it were:
`$(...)`, a backtick and `${...}` all still expand inside double quotes. What makes it
safe is that `local-preflight.sh` prints `base=unsafe` rather than a ref holding any
character outside `A-Za-z0-9._/-`. Stop if you see that, and stop as well if the user
hands you a ref carrying `$`, a backtick, a quote or a semicolon. Do not pass it on.

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
  infer one from, so ask for it: `/codeferret:review origin/main`. When `base=unsafe` or
  `branch=unsafe`, a ref name holds a character that would run as shell where the review
  builds its commands; say which and stop. Otherwise the ref is not in this checkout, and
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
and pull request comments, written by whoever opened them; this session holds the user's
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
  reasoning effort. Leave it out for the model's own default. Nobody has measured what a
  lower effort does to a review here, so treat it as a change to review quality and not
  only to the bill.

Everything the run writes lands in `<git-dir>/codeferret/run/build/`, where `<git-dir>` is
the `repo=` value from step 1, and the findings in `findings.json` beside `run.json`.

## 5. Print what they found

When the run exited non-zero, there may be no `findings.json` at all: a lens with no
`SKILL.md`, a run directory the delete check would not touch, or an orchestrator that
died. Say what the last lines of its output were, and print whatever
`<git-dir>/codeferret/run/build/` does hold: `cost-usd`, `duration-ms` and
`permission-denials` are written before the findings are. Then stop.

Otherwise read `<git-dir>/codeferret/run/build/findings.json`. Group its findings by file,
in diff order, and by line within a file:

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
bash "<plugin>/review/local-post.sh" "<plugin>" "<base>" "<pr>"
```

`<base>` here is always the ref step 1 reported, even when step 4 used `merge_base`. The
review anchors against `<base>` and the pushed head, which is the diff GitHub holds.

Put `DRY_RUN=1` in front of that command to print the review instead of posting it.
Without it, the command posts.
