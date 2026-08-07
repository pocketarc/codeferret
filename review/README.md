# How CodeFerret works

Several review skills read the same diff independently. The orchestrator then merges
their findings into a single review comment on the pull request (PR).

## Shape

```
orchestrator session  ──dispatch──>  one subagent per lens (parallel)
                                     each loads its skill, returns JSON
       │
       └──merge──> findings.json ──render──> one PR review comment
                        │
                        └──artifact──> the next run's suppression
```

A run is one orchestrator and N lens subagents. The orchestrator merges the findings.
`post-review.ts` renders them into one review body and posts it, and the run uploads the
findings file it wrote as an artifact, which is what the next run reads to know what has
already been said.

Every lens reads source and nothing else. Some of the bundled lenses were written for more
than that, and assume a browser or a running application the session does not have. Each one
has a file under `review/lens-extras/` setting out what the gap puts out of reach, and that
file is also what the lens itself reads.
`review/lens-extras/anthropic-accessibility-review.md` does it criterion by criterion.
`lens_health` in the posted review holds what each lens reported it could not check, and
`review-body.ts` adds a standing sentence for each lens in `STANDING_DETAIL`, so a review
says what it did not reach even when a lens forgets to.

There are two ways in, and both call `run.sh`, which is the whole sequence: build the
prompts, read what has already been said, run the orchestrator, check what comes back.
The action calls it in a CI job. `/codeferret:review` calls it through `local-run.sh`,
from a Claude Code session, against the branch in front of you. What differs between them
are arguments to that script: a session reviews uncommitted work if you ask, closes no
threads, and runs under a permission mode that passes a lens's reads and has the
classifier refuse everything else.

## Adding a lens

A lens name resolves in one of two places, so you can add a lens to the action or to a
single repository.

To add one for every repository that uses the action, vendor the skill at a pinned commit:

```sh
bash scripts/vendor-lens.sh <repo> <commit-sha> <in-repo-subdir> <local-name>
```

Then add `<local-name>` to the `lenses` default in `action.yml`, which is the one place a
default is written, and run:

```sh
bun scripts/build-lens-agents.ts
bun scripts/build-defaults.ts
bun scripts/validate-repo.ts
```

`agents/` and `review/defaults/` are both generated. The validator re-runs each generator
with `--check`, so a hand edit to either fails the check. The lens loads
namespaced as `codeferret:<name>`.

To add one for a single repository, put the skill under that repository's own
`.claude/skills/<name>/` and name it in the action's `lenses` input. `build-prompts.sh`
renders it an agent of its own for the run and copies the skill into the run's plugin, so
it loads namespaced like any other. Know what that opens up: the skill is read from the
working tree, so anyone who can push a branch can rewrite it, and it becomes the
instructions for an agent with `Bash` in the job holding the tokens. Naming a workspace lens
puts `.claude/skills/` inside the CI trust boundary. A bundled lens is vendored at a pinned
commit and has no such exposure.

```yaml
- uses: pocketarc/codeferret@v1
  with:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      lenses: |
          caveman-review
          sentry-security-review
          my-repo-conventions
```

If a named lens has no `SKILL.md` in either place, `build-prompts.sh` fails and reports
both paths it searched.

Never fetch a skill at run time. A review job holds a `pull-requests: write` token, so you
should be able to review the code it runs, and that code should not change between runs.
`lenses/skills/PROVENANCE.tsv` records the source repository, commit and path for each
bundled lens, and marks a lens written here as `(first-party)`.

### What vendoring rewrites

A vendored skill is not used the way its author intended, so `vendor-lens.sh` rewrites the
frontmatter fields below:

- `name` becomes the local directory name. All bundled lenses share one plugin namespace,
  and more than one upstream ships a skill called `security-review`.
- `description` is replaced with a scoped one, so that the bundled lenses do not put
  themselves in front of the model during unrelated work. Nothing downstream reads it: a
  lens agent is told which skill to load by name.
- `disable-model-invocation: true` is removed. It leaves a skill reachable only by a
  person typing its slash command, and a lens agent loads its skill through the Skill
  tool, which is model invocation. `cursor-thermo-nuclear-review` shipped with it. Left in,
  it would have left that lens with no skill to load, and the run would still have come back
  healthy.
- `user-invocable: false` is removed, which keeps `/codeferret:<lens>` available for
  running one lens by hand. On 2.1.220 the flag only hides the slash menu entry: Claude
  Code still registers the skill and the model still sees it. The scoped description is what
  keeps a lens out of unrelated work.
- `argument-hint` is removed. Claude Code shows it beside a slash command as you type,
  and upstream wrote it for a person invoking the skill by hand: `accessibility-review`'s
  hint is a Figma URL. A lens agent passes no argument.

The body is rewritten too. `rewrite-markdown.ts` turns `@$1` and `$ARGUMENTS` into the diff
under review, strips a link that reaches above the skill directory, and deletes both a line
that was only such a pointer and any "If Connectors Available" section. What a lens still
cannot follow after that belongs in `review/lens-extras/<lens>.md`.

## Running a review locally

Normally you want `/codeferret:review`. The plugin exists for that, and it handles the
base ref, the pathspec, and an uncommitted working tree for you.

Underneath, both it and the action call `review/run.sh`, so you can run exactly what CI
runs from a checkout of the branch you want reviewed:

```sh
RT=$(mktemp -d)

LENSES=$'caveman-review\nsentry-security-review' \
  EXCLUDE_PATHS="$(cat review/defaults/exclude-paths.txt)" \
  bash review/run.sh test/fixture "$PWD" "$RT/codeferret" "$PWD"
```

`run.sh` has no default for `EXCLUDE_PATHS`, so leaving it out gives the lenses no
exclusions at all, and the lenses spend the run's budget reading lockfiles and build
output.

`PERMISSION_MODE` defaults to `bypassPermissions`, which is what CI passes. Pass `auto`
to run it the way `/codeferret:review` does: a lens gets the reads it needs, anything
else is refused, and refusals are counted in `build/permission-denials`. The header of
`run.sh` lists the rest.

The plugin `run.sh` builds is also called `codeferret`, and so is the installed one. A
plugin passed with `--plugin-dir` takes the namespace and shadows the installed copy, which
is the behaviour you want: the built one holds exactly the lenses this run asked for.

Print the review without posting it. The head is the commit the lenses read, which the
review is recorded against, and `reviewed-commit.ts` reads it back out of the run's
`diff-args`:

```sh
BUILD="$RT/codeferret/build"
FERRET="$PWD"

(cd "$BUILD" && DRY_RUN=1 GITHUB_TOKEN=x GITHUB_REPOSITORY=pocketarc/codeferret \
  bun --config=/dev/null "$FERRET/review/post-review.ts" "$BUILD/findings.json" \
  "$(bun --config=/dev/null "$FERRET/review/reviewed-commit.ts" "$BUILD/diff-args")" 1)
```

The subshell and the `--config` flag are what keep the reviewed tree's own `bunfig.toml`
away from `bun`. "Bun runs whatever a `bunfig.toml` in the reviewed tree names" below has
why every `bun` a review starts takes both.

Use the findings file in the run's own `build/`. `post-review.ts` reads `existing.json`
beside it to know which threads are the run's own, and a run's findings and a different
run's threads need not describe the same pull request.

`review-body.ts` decides what the body prints from two more variables.
`GITHUB_SERVER_URL` and `GITHUB_RUN_ID` name the run holding the artifact, and a runner sets
both: there the body prints the critical and high findings and links the artifact for the
rest. By hand and under `local-post.sh` they are unset, there is no artifact anybody could
open, and the body prints every finding instead, bounded the same way.

Lenses run in parallel, so the bill grows with the number of lenses and the wall clock
barely does. Three took about 15 minutes. An earlier fourteen-lens run with both static
analysis tools took 20m46s for $36.00, returning 97 findings with no permission denials, and
the 12-lens set before that came to $31.80 in 19 minutes over a 47-file diff. Budget between
$2.50 and $2.70 a lens on Opus, and about 20 minutes whatever the count.

`extract-findings.ts` prints that cost, `review/summary.ts` renders it into the job
summary, and the action reports it in its `cost-usd` and `output-tokens` outputs. Read
`modelUsage` in `run.json` if you want the breakdown. The `usage` object beside it covers
the orchestrator's last turn alone, and undercounted one full run sixtyfold.

## Files

| File | Role |
|---|---|
| `../action.yml` | The composite action: its inputs, and the steps of a run. The one place a default is written. |
| `../.claude-plugin/` | The plugin and marketplace manifests. The repository root is the plugin. |
| `../commands/` | `/codeferret:review` and `/codeferret:install-workflow`. |
| `../agents/` | One agent per bundled lens. Generated. |
| `../lenses/skills/` | The bundled skills, one directory per lens. |
| `../templates/` | The workflow `/codeferret:install-workflow` writes into a repository. |
| `lens-brief.md` | The half of a lens's prompt that never varies, and the body of every agent. `__SKILL_LINE__`, `__EXTRAS__` and `__SCHEMA__` are substituted. |
| `lens-extras/<lens>.md` | Text for one named lens, appended to that lens's system prompt. |
| `lens-dispatch.md` | The half that does: which diff to read. `__BASE__`, `__HEAD__`, `__RANGE__`, `__DIFF_SCRIPT__` and `__DIFF_ARGS__` are substituted. |
| `lens-schema.json` | The shape each lens returns. Prompted but not enforced, because subagents do not inherit `--json-schema`. |
| `orchestrator.md` | The orchestrator's prompt template. |
| `resolve-judge.md`, `resolve-none.md` | The two thread-resolution policies. One fills `__RESOLVE__`. |
| `merged-schema.json` | The shape the orchestrator returns. Enforced, because a script parses it. |
| `run.sh` | One review, start to finish. Both front doors call this. |
| `tools/` | Static analysis run before the review. Each writes `build/tool-<name>.json`, in the shape `tools/report.ts` declares. |
| `build-prompts.sh` | Assembles the run's plugin and the orchestrator prompt. |
| `../scripts/render-prompt.ts` | Fills a prompt template's placeholders, and fails on one nothing filled. |
| `local-preflight.sh` | Works out from the checkout what the workflow event would otherwise supply. |
| `local-run.sh`, `local-print.sh`, `local-post.sh` | What `/codeferret:review` runs, so a session pastes no paths and relays no refs. |
| `defaults/` | The `lenses`, `exclude-paths` and `tools` defaults as plain lists, for a session that cannot read a YAML default. Generated from action.yml. |
| `fetch-existing.ts` | Reads the discussion already on the pull request, for the orchestrator to match findings against. |
| `fetch-previous.ts` | Reads the previous run's findings out of its artifact, which is the other half of that match. |
| `previous.ts` | Which artifact that is and what it holds, with `previous.test.ts` beside it. |
| `unzip.ts` | Reads one file out of an artifact's zip, with `unzip.test.ts` beside it. |
| `extract-findings.ts` | Reads the merged findings out of the run log, and what the run cost. |
| `summary.ts` | Renders those numbers into the action's job summary. |
| `check-findings.ts` | The command that checks those findings before anything posts them: argv, printing, the write-back and the exit code. |
| `finding-rules.ts` | What may be wrong with a findings file and what to do about each thing, as functions over a parsed value. `finding-rules.test.ts` beside it. |
| `post-review.ts` | Renders the review body, posts it, and records that it landed. |
| `review-body.ts` | The rendering behind it, with `review-body.test.ts` beside it. |
| `print-findings.ts` | The same findings for a terminal, which is what a session shows instead of a posted review. |
| `findings.ts` | What a run produced: the shape, how a finding ranks, which ones the body prints, and which suppressions hold. `findings.test.ts` beside it. |
| `existing.ts` | The shape of `existing.json` and the one walk over it, so no reader declares its own. |
| `run-files.ts` | The names a run writes its numbers under, which action.yml and summary.ts both read back. |
| `markdown.ts` | Where a fenced block starts and stops, and what a model's prose may open in a posted review. `markdown.test.ts` beside it. |
| `reviewed-commit.ts` | Prints the commit the lenses read, for whoever is about to post against it. |
| `diff-args.ts` | Reads back what the lenses were told to diff, so nothing builds a second range or pathspec. |
| `tool-stub.ts` | Writes the report for a tool that died before it could write one itself. |
| `github.ts` | How these scripts talk to GitHub: the token handshake, the headers, the shape of a failure. |
| `json.ts` | The two narrowings every script here takes on a value it did not produce. |
| `lib.sh` | What a shell script must work out or refuse before passing a value on: the guards, the `gh` handshake, the pull request and the base ref. |

## Why it is built this way

Each decision below came from a failed run.

### Every lens puts its findings in the structured output

If a skill defines its own output format, the subagent follows that format instead,
produces prose, and then has nothing left for the schema. One skill did this, and its
lens returned zero findings after a complete, correct review. The analysis existed and
was discarded. Without that instruction, the failure is silent and looks like a clean
pass.

### The lens's prompt states the base ref

For some skills, the subagent asks the user which commit to diff against. Nothing can
answer in a headless run, so the subagent stalls. `lens-dispatch.md` names the ref
itself, and `lens-brief.md` states both facts: the ref is decided, and there is nobody
to ask.

### Only the orchestrator's output is enforced

Subagents do not inherit `--json-schema`. That is fine, because a model reads their
output and handles drift. A script parses the orchestrator's output, so that output is
validated.

### The orchestrator merges the findings

Two lenses routinely report the same defect at different lines, one at the line where
tainted input arrives, one at the line where the damage happens. If you deduplicate by
file and line, you miss those. If you widen the tolerance, you merge genuinely separate
findings. Whether two findings are the same defect is a question about meaning, so a
model answers it.

### The orchestrator also decides what has been said before

Every push re-runs the whole review, so without this the run after the second push raises
the same 37 findings again and the pull request becomes unreadable. Matching a new finding
against an earlier one is the same question as merging two lenses' findings: the line has
often moved, and the words are rewritten every run. So the orchestrator marks each finding
`new`, `already-reported`, or `declined`, and `post-review.ts` posts only the new ones.

A suppression does not rest on the orchestrator's word alone. `vetSuppression` reads what
each one cites back out of `existing.json` or `previous.json`, and reopens whatever those
files do not bear out.

A decline needs an owner, a member or a collaborator, or a thread somebody closed. Closing
one takes repository write: without it, `resolveReviewThread` fails. So a closed thread is
evidence that somebody with write access settled it. Replying to one takes no more than
commenting and does not reopen it, so a reply there settles the file its thread is anchored
to and no other.

An `already-reported` finding is held to less, because it stays a finding in the file and
loses only its paragraph. Anyone's comment settles it. What it still needs is that the
comment exists on this pull request and is about the same file.

Most of them cite no comment at all. Under STEP 3 the orchestrator takes the status from
`previous.json` and names a url only where the entry carries one, so the ordinary
`already-reported` finding arrives with nothing named. For a while that was the one status
the orchestrator decided and nothing re-decided. It is now held to the same bar against
`previous.json`: the last review has to have raised something in the finding's file.

The bar is the file, even though the title is what the orchestrator matches on. It is told
to match the defect rather than the prose, and the lenses word the same defect differently
every run, so an exact title comparison reopened all seven suppressions of the run it was
measured against. The file is what both sides can agree on.

Every bar goes through the same file test. A reply on a thread anchored to the finding's file
counts on its own; anything else, a conversation comment included, has to name the path, or
a basename of four characters or more with nothing but punctuation or space either side.
Without that test, a maintainer who comments "LGTM, merging" settles every finding on the
pull request. What is left is that a maintainer settling one finding in a file settles every
finding this run made in that file, which is the direction to be wrong in.

Neither file is taken as the orchestrator left it. `existing.json` is fetched a second time
once the session has exited, and `previous.json` is copied aside before it and put back
after, along with `diff-args` and `lens-list.txt`. The orchestrator holds every one of those
paths in its prompt and has `Bash` under `bypassPermissions`, so the first copies could have
been written by the session they are evidence about. The second fetch also picks up whatever
was said during the twenty minutes the review took; a restored copy that differs from what
went in is reported on stderr, because nothing else in a run would show a lens rewriting the
diff the others read.

It matches against two files. `build/previous.json` holds what the last run reported, and
that is where a repeat is caught. `build/existing.json` holds the discussion on the pull
request, every author included. A defect a human already raised does not need raising
again, and a reply is where the answer to a finding lives: "we don't want that" makes a
finding `declined`, which the review reports separately from the ones merely said before.
Two things a reply cannot do, both in `orchestrator.md`: it cannot make a security defect
safe by asserting the code is intentional, and it cannot settle a finding it does not
address.

Two rules keep that safe. The orchestrator marks a finding `new` whenever it is unsure,
because a repeated comment costs the author seconds while a suppressed finding is one
nobody ever sees. And suppression is visible: the review body prints the count and the
run artifact holds every finding with its status, so a matcher that starts eating
findings shows up as a number.

An outdated comment does not count as covering anything. GitHub collapses a comment when
the line it referred to changes, so a defect that survived an edit still needs saying.

### The previous run's findings come out of its artifact

Nothing GitHub's comment APIs return includes a review body. `fetch-existing.ts` reads
`reviewThreads`, which is inline comments, and `issues/{n}/comments`, which is the
conversation; a review body is neither. The whole review is a body now, so without this the
run after it could see none of it. This predates the change: on the last run before it, the
cap at forty comments left 60 findings of 100 in the body alone, and every one of those was
going to be raised as new on every push for as long as the pull request stayed open.

So `fetch-previous.ts` fetches `codeferret-run` artifacts for this pull request's branch,
newest first, reads `findings.json` out of the zip, and writes the file, line, title and
status of each finding to `build/previous.json`. The bodies are left behind: matching is on
the file and the title, and pulling a previous review's prose into this run's context adds
nothing.

Every one of these has to be true of an artifact before what it holds can suppress a
finding. `previous.ts` answers each of them.

Its review has to have been posted. `post-review.ts` writes `posted` into `findings.json`
once GitHub has accepted the review, and the action uploads after that, so the record
travels inside the one file every consumer keeps. Ordinary paths reach an uploaded artifact
with no review on the pull request: `post: 'false'`, a 502 from the reviews endpoint, and a
token without `pull-requests: write`. A run killed by `cancel-in-progress` used to be
another, and the upload step's condition is `!cancelled()` so that it is not: with
`artifact-path: '.'` the build directory exists within seconds, so under `always()` every
superseded push uploaded an artifact whose review was never posted. A run that takes one of
those for a posted review marks every finding `already-reported` against comments nobody
ever saw, and writes that status into its own findings file, so the suppression lasts as
long as the pull request. That is the failure this whole path exists to avoid, caused by the
path itself. A run that ends red is a different case and still counts: `check-findings.ts`
drops what it cannot use, the review lands, and the job goes red over what was dropped. So
the newest artifact with a posted review wins, and one without is stepped over for the run
before it.

A run with nothing new to post records itself anyway, with a null url. It suppressed
everything on the strength of a review that did land, and `previousRun` opens ten artifacts
before giving up: without a record, ten quiet pushes would put that review out of reach and
the eleventh run would raise the whole review again on a pull request that was already
clean.

That review has to have been of this pull request. Artifacts are found by head branch, and
a branch name is evidence of nothing: `fix/lint` and a release branch are deleted on merge
and recreated inside the retention window, and GitHub allows one branch to head two open
pull requests against different bases. So `post-review.ts` writes the number into the
`posted` record and `previous.ts` requires it to match. A record with no number comes
from a release that wrote none, and it does not match, which costs one round of repeated
comments.

It has to have come from a run of a branch pushed here. For a `pull_request` event GitHub
runs the workflow files as the pull request has them, so a fork's copy of the workflow
runs, and whatever it uploads is stored against this repository and listed by the artifacts
endpoint. `head_branch` is a name whoever opened the pull request chose, and open branch
names are public, so matching on it is no evidence at all. What a fork run cannot produce
is a match between the producing run's `repository_id` and its `head_repository_id`, so
that is what is required.

And it has to have come from a run of this workflow. The artifacts endpoint lists every
`codeferret-run` artifact in the repository whatever produced it, so without this check
anyone who can push a branch can add a throwaway workflow that uploads a `findings.json`
holding a `posted` record and a list of file and title pairs, let it run once, and delete
the workflow in the next push. The artifact outlives the branch for the whole retention
window, the endpoint lists it ahead of every genuine one, and the next review marks each of
those findings `already-reported`. Changing `fetch-previous.ts` would do the same thing and
be in the diff a reviewer reads; this leaves nothing behind. So `fetch-previous.ts` reads
its own run's `workflow_id` and requires the producing run to name the same one. In a
session nothing names a workflow and any run counts, because what a session does with a
previous artifact is print it to the person who asked for it.

Reading an artifact needs `actions: read`, which the shipped workflow grants and a consumer
can decline. So every failure is a line on stderr and a file holding no findings. No
permission, no artifact, a retention window that has closed, and a first run all mean the
same thing: every finding is new. That is what happened before this existed, so a repository
that grants nothing is exactly where it was. `unzip.ts` reads the archive itself rather than
shelling out to `unzip`. That binary is not on every runner, and it is rarely in the
container a `command-prefix` points at, where a missing binary would look identical to a
pull request with no previous run. `unzip.ts` also bounds what one entry may inflate to,
because deflate reaches past 1000:1 and an out-of-memory kill is the one failure this path
is not allowed to have.

### Excluded paths are excluded in git

The `exclude-paths` input becomes a pathspec on the diff command each lens is given, so
a lockfile is not in the diff at all. `build-prompts.sh` writes that pathspec to
`build/diff-args`, and everything downstream that needs it reads that file back. Two
constructions of the same pathspec drifted once, and the anchor map `post-review.ts` built
then covered files no lens had read.

### Text for one lens goes in that lens's own prompt

Text meant for one lens reaches it through `review/lens-extras/<lens>.md`, which
`scripts/build-lens-agents.ts` renders into that one agent's system prompt. Handing it to
every lens pushes them all toward the same generalist read, and the differentiated findings
come from lenses staying inside their own domain: on a ten-lens run the RSC boundary
violation, the missing index, and the keyboard-access failure were each found by exactly
one lens.

Routing it through the orchestrator instead is worse than either. Put that instruction in
the orchestrator's prompt and the routing becomes a judgement the orchestrator remakes every
run, with nothing downstream to show when the text went to the wrong lens or to all of them.

What the directory holds is what a vendored skill assumes and this run cannot provide:
that there is no browser and no running site for `copilot-web-design-reviewer`, that a
criterion needing a rendered page is out of reach for the accessibility lens, and that the
SQL lens's offer of a whole-project pass does not apply.

Read a change to one of these files yourself, against the skill it overrides. When
CodeFerret reviews this repository, the file under review is the instruction that the lens
reviewing it ran under, and that lens can only notice a gap in the file by reading past its
own prompt. `validate-repo.ts` catches a file that names no lens, and nothing catches
one whose instructions no longer match the skill it overrides.

A second directory used to hold per-lens text that depended on the run, spliced into the
lens list and handed on by the orchestrator. It is gone, for the reason the paragraph above
gives: it made the routing a judgement remade every run. Nothing needed it. A lens that
wants a path this run wrote can take it from the directory holding the `diff-args` file its
dispatch already names, which is how `static-analysis` finds the tool reports.

### A finding shows the claim and nothing else

No severity, no lens attribution, no count of how many lenses agreed. All three stay in
`findings.json`, and severity still orders the findings, but none of it is printed beside
a finding.

Severity is withheld because a lens assigns it without the context that decides it. A
missing index is critical on a large table and irrelevant on a small one, and the lens
cannot tell which. Displaying the guess turns the lens's ignorance into the reader's
permission to skip. The same argument rules out filtering by severity: a label too
unreliable to show is far too unreliable to hide findings with.

Which findings the body prints in full is a different question, and `isListed` answers that
one from severity where there is a run behind the review. The critical and high findings go
in the comment; everything else is one download away in the artifact's `findings.json`. A
severity nothing recognises goes in the comment too, and the heading then reads "Findings
worth stopping for" rather than naming two severities when one of the findings is neither.
Nothing is hidden by that, which is what made it acceptable: the reader who acts on a review
is an agent reading the file, and the comment is where a person decides whether to stop and
look. Hiding a low finding from the file would be the filtering the paragraph above rules
out.

A review posted from a session has no artifact, and its findings file is a path under
`.git/` on one person's machine. Nothing branches on severity there: the body prints every
finding, and `assemble` cuts from the end and says how many did not fit. Splitting the
review between a comment and a file only works where both are reachable.

Agreement between lenses is withheld because it tracks how conspicuous a defect is, not
how much it matters. On a ten-lens run the most-corroborated finding was a cache-key nit
that six lenses spotted, while the missing index, the RSC boundary violation, and the
keyboard-access failure were each found by one. Showing "6 of 10" beside the nit tells
the reader it is the consensus priority, which is the opposite of the truth.

### The orchestrator decides which threads to close

A thread is finished when its defect has left the code or when someone settled it, and
neither is a question a rule answers. `isOutdated: true` means the anchored line changed,
which a fix landing elsewhere does not produce and an unrelated edit above does, so the
orchestrator weighs it against the diff. It leaves open any thread a human opened, any
whose last comment asks an unanswered question, and any it is unsure about. Each closure
has a reason, and `review-body.ts` prints them in the review, so a wrong call is visible.

Which threads are the run's own is decided by two things together: the login the review
posts under, and a hidden marker in the comment that opened the thread. `github-actions[bot]`
is the login of every workflow posting with `github.token`, so the login alone would put
another workflow's threads on the list this run may close. The marker alone is worse: an
HTML comment renders as nothing, so anyone who can open a review thread could write it into
their own and have this run adopt the thread. Both halves are required.

Nothing writes the marker now. A body-only review creates no threads at all, so what is left
to recognise are the threads left open by the runs made while the plugin work was in
progress. A trailing `<sub>` category line counted as a second shape for a while, on the
theory that a released version had ended its inline comments that way. No version has been
released, every thread this run has seen carries the marker, and markup anyone can reproduce
proves nothing about who wrote a comment, in a test whose whole job is to be narrow. So it
went.

A resolved thread also settles its finding: `resolved: true` marks it `declined` with no
reading of replies. That makes resolving a thread the way to dismiss a finding for good.
It also takes write access, which commenting does not.

Outside CI the review posts under a person's own account, so `RESOLVE_THREADS=0` renders
`resolve-none.md` in place of `resolve-judge.md` and the orchestrator closes nothing. Each
policy is its own file, so the prompt states one policy whichever way the run goes.

### The review is one comment

It used to be up to forty inline comments plus a body. That existed because a comment was
the only way to deliver a finding, and it made a forty-comment pull request out of a review
nobody had read yet. What acts on a review here is usually an agent, and what it reads is
`findings.json` in the run's artifact, which is complete: every finding with its body, its
severity and the lenses that found it, the suppressed ones included. So the comment is for
the person deciding whether to stop, and the file is for whoever fixes it.

That leaves a body holding the summary, the counts, `lens_health`, and the findings the
paragraph above says belong in it. `review-body.ts` bounds it: the short
sections that make the review honest are assembled first, the listing takes what is left,
and it drops whole findings from the end rather than being cut at a character offset, which
would land inside a `<details>` or a fenced block and leave GitHub rendering the wreckage.

A good deal went with the inline comments. Whether a line sat inside a diff hunk was checked
here rather than taken from the lens's own `in_diff`, which was wrong on every run; the
reviews API is atomic, so one bad anchor returned 422 and created no comments at all.
Findings outside the diff went into the body under a heading of their own. A cap at forty
kept the batch under a secondary rate limit that had refused 95 comments twice, sixty
seconds apart, and every one of them was lost.
None of it applies to a body with no comments in it. Whoever adds the first inline comment
back has to bring all of it with them.

### `lens_health` covers every lens dispatched

A lens that spends money and returns nothing exits successfully and looks identical to a
clean run. That is survivable at three lenses and invisible at twenty.

Zero findings is treated as a failure, with one exception: a lens that returns nothing
and names a checkable reason for it, which the orchestrator reads against the diff before
accepting. The exception exists because the earlier rule left correctly-empty domain
lenses filed as broken. Half the default set is domain lenses, and a tooling diff leaves
the SQL, Next.js, accessibility and web design ones with nothing in their domain; three
warnings on a healthy run teach a reader to skip the line, and the line is the only place
a lens that really did die shows up. A lens that returns nothing and says nothing is still
a failure.

A review is posted even when nothing survives. Zero findings and a failed lens is the shape
of a review that never happened, and posting nothing leaves a pull request looking clean.

### The reviewed tree does not configure the session

`--strict-mcp-config` with no config file disables MCP servers: they added roughly 28k
tokens per session, a diff review uses nothing they provide, and a `.mcp.json` on the
reviewed branch would otherwise be read.

`--setting-sources user` closes the two channels beside it. The session starts inside the
reviewed working tree, so without the flag Claude Code loads that branch's `CLAUDE.md` as
instruction into the process that decides which findings are `new`, and its
`.claude/settings.json` as settings. Both were measured on 2.1.220 against a real
dispatch: the model reads the memory file, and a `SessionStart` hook declared in project
settings runs even under `--permission-mode bypassPermissions`. That hook is a shell command
whoever pushed that branch wrote. Plugins passed with `--plugin-dir` still load, so the lens
agents are unaffected, and text meant for one of them reaches it through
`review/lens-extras/` instead.

### Bun runs whatever a `bunfig.toml` in the reviewed tree names

Bun reads `bunfig.toml` from its working directory, and `preload` in that file names a
script bun runs before the one on the command line. Bun looks in the working directory and
nowhere else: the script's own path does not matter, and bun does not walk up from the
directory it starts in. `--config=<path>` replaces that lookup outright, and the local file
is then ignored. Measured on bun 1.3.5; `-c` is the same flag and takes its value with an
`=`, so `-c file` is read as an entry point.

A review is a job holding `CLAUDE_CODE_OAUTH_TOKEN` and a `pull-requests: write` token, and
a run is several `bun` invocations, two of which are handed that token. So one `bunfig.toml`
on a branch is enough for bun to run the script it names inside that job, before a lens is
dispatched, with no model in the loop and nothing to inject. Under `/codeferret:review` bun
runs that script on the developer's machine, whatever the permission mode, because the only
command Claude Code is asked to approve is `local-run.sh`.

The working directory was the first answer and it is not enough on its own. It closes the
branch's own file: `run.sh` runs from `$BUILD`, `build-prompts.sh` and `local-post.sh` run
theirs from there in a subshell, and the action's `bun` steps set `working-directory`. But
every directory the session is still allowed to run from is one it can write. The
orchestrator has `Bash` under `bypassPermissions` and its prompt names `$BUILD` absolutely,
so `touch $BUILD/bunfig.toml` moves the same execution one step along. Under
`command-prefix` the working directory is the prefix's own, which the action asks to be the
repository root, so there it closed nothing at all.

So every `bun` a review starts takes `--config=/dev/null` as well. That replaces the
lookup wherever the process happens to be standing, and `/dev/null` is the one path on a
runner whose contents nothing short of root can change. Every invocation takes it: `run.sh`,
`build-prompts.sh`, action.yml and the `local-*` scripts.

The working directory still moves, because a relative path in a report or an argument
resolves against it. Only the orchestrator starts in the workspace, in a subshell of its
own, because its lenses read whatever tree their session started in. The tools take the
workspace as an argument and ask git for the top level from there.

### A lens agent ships pre-built

What changes between runs is the base ref and the pathspec, and both reach a lens
through the message the orchestrator sends: the ref as text, the pathspec as the path to
a generated `diff.sh`. What does not change (which skill to load, the output schema,
report-do-not-repair) is the agent's own system prompt, so `agents/` is rendered once by
`scripts/build-lens-agents.ts` and checked in. That split lets a session run the same
lenses the action does: Claude Code loads a plugin's agents when the session starts, and
nothing can add more halfway through.

A lens the plugin does not bundle has no agent to check in, so `build-prompts.sh` renders
one into the run's plugin with the same script, and copies the skill in beside it. It used
to dispatch the generic agent and tell the orchestrator which skill to pass on, and a lens
that never received that line returned a competent general review under its name with no
skill loaded.

The copy is what makes a workspace lens work at all. `--setting-sources user` takes a
project's own `.claude/skills/` with it, measured against a real dispatch on 2.1.220: a
session started in a directory holding one could not find it, and the same session without
the flag loaded it. Left where it lives, every workspace lens would follow its agent's own
instruction to stop and return nothing, which is the failure the paragraph above describes.

### The action assembles its plugin in `RUNNER_TEMP`

It copies in only the lenses named for that run, so an unrequested lens has no agent to
dispatch and no skill to load, which is a second lock on the `lenses` input besides the
list in the prompt. Building it outside the workspace also leaves the calling
repository's tree untouched. A session skips all of this: it has the plugin installed
already.

### A static analysis tool reports to a lens

A tool finding means a pattern matched, and whether anything is wrong here is a separate
question; the `static-analysis` lens's own prompt has the argument. So
`review/tools/*` run before the dispatch and write their reports into `build/`, and that
lens reads each finding against the code and drops what does not hold. What it keeps
becomes the comment the rule could not write: the input, the path it takes, and the fix.

### Each tool has its own pathspec

`exclude-paths` keeps lockfiles out of the review because nobody wants a reviewer
reading one, and a lockfile is exactly what `osv-scanner` needs: it is the only thing
here that can say a dependency has an advisory against it, which is the one job no lens
can do at all. So each tool takes the range from the run's own diff (the same commits
every lens reads) and sets its own pathspec. `semgrep` keeps the review's; `osv-scanner`
drops it. `exclude-paths` is about what deserves a reader's attention, not a machine's.

Nothing else changes shape. The orchestrator still merges N lens reports and still
deduplicates on what the defect is, so a rule and two lenses that spot the same thing
produce one comment with three names in `found_by`. When a tool does not run, the lens says
so, and the orchestrator already reports that in `lens_health`.

That lens is told to keep anything it cannot rule out, for the same reason the
orchestrator marks an uncertain finding `new`: a wrong keep costs a reader seconds, and
a wrong drop is a finding that will be raised and discarded on every run without anybody
seeing it. It reports how many it dropped, and `build/tool-*.json` holds what it was
handed, so its judgement can be checked against the report.

Each report caps what it hands the lens at 100 findings, and it caps the low end: semgrep's
findings are sorted `ERROR` first and osv-scanner's by CVSS score before either is cut. A
cap in emission order would drop a hundred `INFO` hits' worth of real ones.

`build/tool-<name>.json` is therefore the lens's input and not the whole record. Past the
cap a run also writes `build/raised-<name>.json`, holding every finding the tool produced.
The name sits outside the `tool-*.json` glob `review/lens-extras/static-analysis.md` points
the lens at, so widening the record does not widen what the lens reads.

Both those checks need the file. `artifact-path` defaults to `findings.json`, so on the
default the tool reports die with the runner and the check is possible only while the run
directory is still on disk: the local path, and this repository's own workflow, which sets
`artifact-path: '.'`. A consumer who wants to audit what a lens dropped has to widen it, and
gets `run.json` with the rest.

### The orchestrator runs in its own process

A review reads two things written by whoever opened the pull request: the diff, and
every comment on it. A Claude Code session holds an editor, a shell, and whatever its owner
has connected over MCP. Untrusted text and that set of tools in one context is the whole of
prompt injection, so `run.sh` spends a second process keeping them apart. The session reads
`findings.json` back and nothing else.

### Which permissions a lens gets is an argument

CI passes `bypassPermissions`: the runner is disposable, and a classifier that refused a
lens halfway would narrow a review that cost $36 to produce. `/codeferret:review` passes
`auto`. Under `auto`, a lens can run `git diff`, `git log` and `rg`, and the classifier
refuses the rest. That was measured on a real dispatch. Either way
`permission_denials` is counted out of the run log and reported, so a mode that starts
refusing commands a lens needs shows up as a number.

### A bundled lens's `description` is rewritten

Upstream wrote each one to win an invocation, and `writing-review`'s reads "proactively
whenever writing, reviewing, or rewriting text". That is right for a skill somebody
installed deliberately and wrong for a set that arrived inside a code review tool.
Once the plugin is installed, those descriptions put a lens in front of the model during
unrelated work. `prepare-skill.ts` replaces them all, and nothing downstream reads them,
because a lens agent is told which skill to load by name.

### A lens agent names the tools it gets

Naming them leaves out every MCP tool, which a diff review has no use for and which
`--strict-mcp-config` already removes for the action. The catch is that a name Claude
Code does not recognise is dropped in silence, and so is one that conflicts with another
name in the same list. `Grep`, `Glob`, and `TodoWrite` were all in the list and none
reached the agent: `TodoWrite` is not a name on 2.1.220, and `Grep` and `Glob` are
refused to any agent that also asks for `Bash`, which every lens needs for `git diff`.
That pair is mutually exclusive by design, and Claude Code returns the explanation to the
agent and to nobody else: "Grep is not available in this session — search file contents
with grep via the Bash tool instead." So the list has to be checked against a real
dispatch whenever it changes.

## Using the action in another repository

1. Add a workflow that grants `pull-requests: write`. A composite action cannot grant
   itself permissions, so the calling workflow must declare it. Without it, the posting
   step fails with 403.

   To let CodeFerret resolve finished threads, add `contents: write` and set
   `resolve-threads: 'true'` on the step. Both are needed: `resolveReviewThread` requires
   repository write access, which `pull-requests: write` does not give, and without the input
   set the run neither judges a thread finished nor asks to close one. Granting the
   permission alone buys a token that can push and closes nothing. Weigh it: the review agent
   runs with `bypassPermissions` and Bash, so a token that can write contents is a token that
   can push. Without either, everything else works and nothing tries to close a thread.

   `actions: read` is what stops every finding being posted again on every push, and the
   template grants it. "The previous run's findings come out of its artifact" above says
   why, and what a repository that declines it gets instead.

2. Set `CLAUDE_CODE_OAUTH_TOKEN` as a repository secret. Create the token with
   `claude setup-token`.

No checkout step is needed. The action checks out the pull request head with full history,
but only when the workspace has none, so it never cleans away work an earlier step
produced. Check out yourself and set `checkout: skip` if you need submodules, LFS, or a
sparse checkout.

The action also installs `bun` and `claude` when they are not already on PATH. Set
`install: skip` to provide them yourself, which is also how you pin their versions: on the
default, a job that holds your OAuth token installs whatever npm has as the latest.

Use `command-prefix` when the repository runs its toolchain in a container. For example,
`docker compose exec -T -w /app devtools`. The prefix must put both binaries on PATH and
start in the repository root, because the review reads the working tree and runs `git
diff`. It must also mount three paths where the runner has them: the checkout,
`$GITHUB_ACTION_PATH` for the scripts the prefix runs, and `$RUNNER_TEMP/codeferret` for
the run's plugin, the diff command each lens is handed and the tool reports. The
run checks the last two before it dispatches anything, because a lens that cannot reach the
build directory reads no diff and returns a review that is empty for no stated reason.

Actions provides `GITHUB_TOKEN`, so `github-token` only needs setting to override it. Set
`own-login` with it: a run tells its own review threads from a person's by the login they
were posted under, and a token that is not the default posts under a different one.

## Releasing

Consumers pin `pocketarc/codeferret@v1`. GitHub resolves that as a plain git ref, so `v1`
is a mutable tag this repository moves on every release. Skip the move and every consumer
stays on the previous revision with no sign anything happened.

```sh
git push origin main
git tag -a v1.2.0 -m "CodeFerret 1.2.0"
git tag -f v1 -m "CodeFerret v1"
git push origin v1.2.0
git push --force origin v1
```

A change that breaks a consumer's workflow (a new required input, a permission they now
have to grant, work moved out of the action and into their job) needs `v2` and a `v2` tag,
because `@v1` carries it to everyone the moment the tag moves.

The test is whether their job still works. 1.1.0 is the case that settled it: it stops
posting inline comments, prints only the critical and high findings in the body, and uses
`actions: read`, which an older workflow does not grant. Every one of those degrades
gracefully: the review is still posted, and a consumer who never grants the permission gets
each finding raised again on every push, which is what the reviews looked like before. Nothing
there needs a consumer to edit anything, so it stayed on `v1`. A change that would leave
their job red, or leave no review posted at all, needs `v2`.

Bump `version` in `.claude-plugin/plugin.json` to the same number in the same commit.
Plugin users see it in `/plugin`, and it is the only version they are shown.
`validate-repo.ts` checks every `@vX.Y.Z` in the template, the install command, the README
and CLAUDE.md against that number. Advice naming a tag nobody cut fails the consumer's job
at load, and that advice is the one escape hatch from the mutable tag.

Plugin users are not on tags at all. `/plugin marketplace add pocketarc/codeferret`
follows this repository's default branch, and `/plugin update` gives them whatever is on
it. So nothing reviews or approves what lands on `main` before plugin users get it: they
get whatever is there the moment it lands, while an action consumer sees nothing until
`v1` moves. Keep `main` releasable.
