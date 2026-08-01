---
description: Review this repository's diff through CodeFerret's review lenses.
argument-hint: "[base-ref] [lens…]"
---

Review this repository's diff through several review lenses at once and print what they
find. Work through the steps in order.

`$ARGUMENTS` holds what the user typed. Its first word, if there is one, is the ref to
diff against; anything after that names the lenses to run. Both are optional.

Throughout, `<plugin>` is `${CLAUDE_PLUGIN_ROOT}`, and `<git-dir>`, `<base>`, `<head>`
and the rest come from step 1. Substitute them yourself rather than relying on a shell
variable: each command runs in its own shell, so nothing you export survives.

## 1. Find out what this checkout supports

```sh
CLAUDE_PLUGIN_ROOT="<plugin>" bash "<plugin>/review/local-preflight.sh" <base-ref if the user gave one>
```

It prints one `key=value` per line. Read them all before doing anything else.

Stop, and say which line stopped you, when:

- `plugin=missing` — the plugin root did not resolve, so nothing below will work.
- `repo=missing` — this is not a git repository.
- `head=none` — this repository has no commits yet.
- `base_resolves=no` — name the ref that failed. When `base=none` there was nothing to
  infer one from, so ask for it: `/codeferret:review origin/main`. Otherwise the ref is
  simply not in this checkout, and `git fetch origin` usually settles it.
- `shallow=yes` — a shallow clone has no merge base to diff against. `git fetch
  --unshallow` fixes it, and it goes to the network, so ask first.

Carry on, but say so, when:

- `bun=missing` — the findings cannot be checked or posted, and everything else works.
  Bun installs from https://bun.sh.
- `gh=missing` or `gh=unauthenticated` — nothing can be posted, and the base ref falls
  back to the repository's default branch rather than a pull request's.

## 2. Settle what is under review

A `<base>...HEAD` diff covers committed work only. When `dirty` is not `0`, say how many
files are uncommitted and ask which the user wants:

- **Committed work only** — the same diff the action would review.
- **Uncommitted work as well** — diffs the working tree against `merge_base`. A git diff
  never shows an untracked file; `git add -N <path>` brings one in.

## 3. Settle the lenses

Lenses named in `$ARGUMENTS` win. Otherwise read `<plugin>/review/defaults/lenses.txt`,
which is the set the action runs.

Before dispatching, say how many lenses are about to run and that twelve of them take
around 15 minutes and cost several dollars on Opus. Let the user stop you there.

## 4. Build the prompts

```sh
printf '<one lens per line>\n' | \
  EXCLUDE_PATHS="$(cat "<plugin>/review/defaults/exclude-paths.txt")" \
  PROMPTS_ONLY=1 \
  bash "<plugin>/review/build-prompts.sh" <base> "<plugin>" "<git-dir>/codeferret/run" "<repo root>"
```

Reviewing uncommitted work as well: pass `merge_base` as `<base>` and add
`INCLUDE_WORKING_TREE=1` to that environment.

When `pr` is a number and `gh=ok`, collect what has already been said on that pull
request, so the review does not raise what somebody has already answered:

```sh
GITHUB_TOKEN="$(gh auth token)" \
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
  bun "<plugin>/review/fetch-existing.ts" <pr> \
      "<git-dir>/codeferret/run/build/existing.json" "$(gh api user --jq .login)"
```

Run it after building the prompts, which writes an empty file in its place. A failure
here is worth a mention and nothing more: an empty file costs duplicate comments, where
stopping costs the whole review.

## 5. Run the review

Read `<git-dir>/codeferret/run/build/orchestrator.txt` and follow it exactly. It is the
prompt the action gives its own orchestrator, so it already says how to dispatch, how to
merge, and what to account for.

Two things it leaves out, because a GitHub Actions run settles them elsewhere:

- Pass `model: opus` on every Agent call, unless the user asked for something else. The
  action runs its lenses on Opus and the findings are worth what the model is.
- Leave `resolve` empty, whatever step 4 of that prompt says. On a runner CodeFerret
  comments under its own account and can tell its threads from a human's. Here it
  comments as the user, so it cannot, and closing someone's thread takes their words off
  the page.
- Its result is a JSON object. Write that object to
  `<git-dir>/codeferret/findings-<head>.json` instead of printing it, then check it:

```sh
bun "<plugin>/review/check-findings.ts" "<git-dir>/codeferret/findings-<head>.json"
```

Correct the file and check it again if it reports a problem. Do not print findings that
did not pass.

## 6. Print what they found

Group the findings by file, in diff order, and by line within a file:

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
what it did. A lens that returned nothing is more likely broken than satisfied, and this
is the only place that shows.

Finally, say where the findings file is, and offer to work through the findings.

## 7. Offer to post it

Only when `pr` is a number, `gh=ok`, `pushed=yes` and `dirty=0`. Otherwise name whichever
of those is not true and leave it: comments are anchored to a commit GitHub holds, so a
review posted from work GitHub has never seen lands on the wrong lines or on none.

Ask before posting. It writes to a pull request other people are reading.

```sh
GITHUB_TOKEN="$(gh auth token)" \
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" \
  EXCLUDE_PATHS="$(cat "<plugin>/review/defaults/exclude-paths.txt")" \
  bun "<plugin>/review/post-review.ts" \
      "<git-dir>/codeferret/findings-<head>.json" <base> <head> <pr>
```

`EXCLUDE_PATHS` has to be the list the lenses were given, or a finding can anchor to a
file they never saw.

Add `DRY_RUN=1` to that environment to print the review instead of posting it. Without
it, the command posts.
