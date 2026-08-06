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

Throughout, `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`, and `<pr>` and `<base>` are the number
and the ref step 1 prints. Substitute them yourself rather than relying on a shell variable:
each command runs in its own shell, so nothing you export survives. Put double quotes around
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
- `plugin=unsafe`. The plugin sits under a directory whose path would run as shell where
  the review builds its commands. Say so and stop.
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

Before running, say how many lenses it is, taking the number from that file rather than
from here, and what it costs: a fourteen-lens run took 20m46s and $36.00 on Opus and
returned 97 findings, and the bill scales with the number of lenses rather than the wait.
Then stop and wait for the user to agree, in a turn of their own. A bare
`/codeferret:review` is the whole default set, and someone typing it to see what the command
does has not agreed to that.

## 4. Run it

The review runs as its own `claude` process rather than in this session. It reads a diff,
and pull request comments, written by whoever opened them. This session holds the user's
editor, shell and MCP servers, and there is no reason to introduce the two.

Run it in the background. It takes tens of minutes, which is longer than a foreground
command is allowed.

```sh
bash "<plugin>/review/local-run.sh" "<plugin>" ""
```

`local-run.sh` works out the run directory, the defaults, the gh credentials and the base
ref itself, and prints which base it settled on. The empty second argument is what leaves
the base to it. Add to that command line where these apply:

- A ref in place of the empty string, when the user named one in `$ARGUMENTS`. Otherwise
  leave it empty rather than passing back the `base` value step 1 printed: both are worked
  out the same way, and a ref retyped is a ref that can be retyped wrong.
- The lenses the user named, as further arguments. Naming any lens but `static-analysis`
  also drops the static analysis tools, whose reports only that lens reads.
- To review uncommitted work as well, pass the `merge_base` value in place of the empty
  string and put `INCLUDE_WORKING_TREE=1` in front of the command.
- `EFFORT=low` (or `medium`, `high`, `xhigh`, `max`) in front of the command to set
  reasoning effort on the orchestrator's session. Leave it out for the model's own default.
  Whether it reaches each lens is unmeasured, and so is what turning it down costs a review.

Everything the run writes lands in `<git-dir>/codeferret/run/build/`, where `<git-dir>` is
the `repo=` value from step 1, and the findings in `findings.json` beside `run.json`.

## 5. Print what they found

When the run exited non-zero, there may be no `findings.json` at all: a lens with no
`SKILL.md`, a run directory the delete check would not touch, or an orchestrator that
died. Say what the last lines of its output were, and print whatever
`<git-dir>/codeferret/run/build/` does hold: `cost-usd`, `duration-ms` and
`permission-denials` are written before the findings are. Then stop.

Otherwise print the findings:

```sh
bash "<plugin>/review/local-print.sh" "<plugin>"
```

Relay what it prints, whole and unedited. It opens with the run's `summary`, gives each new
finding as `path:line`, a title and a body, counts the ones a previous round already
answered, and closes with every lens that could not report and every lens that named
something it could not check. It uses `review/findings.ts` and `review/review-body.ts`, the
same modules a posted review is rendered from, so what you show here and what the action
would post cannot disagree.

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

Say what a review posted from here does not leave behind. The action reads what the last
review raised out of that run's `codeferret-run` artifact, and a session's findings file
never becomes one, so the next action run on this pull request has nothing to match against
and posts every one of these findings again. Warn the user, so the repeat does not read as
a bug.

Ask before posting. It writes to a pull request other people are reading.

```sh
bash "<plugin>/review/local-post.sh" "<plugin>" "<pr>"
```

`local-post.sh` takes the head from the run itself, refuses when HEAD has moved since, and
refuses when the pull request's head is a different commit. Report what it says rather than
working around it.

Put `DRY_RUN=1` in front of that command to print the review instead of posting it.
Without it, the command posts.
