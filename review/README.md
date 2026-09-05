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
than that, and assume a browser, a running application or a connected database the session
does not have. Each one has a file under `review/lens-extras/` setting out what the gap puts
out of reach, and that file is also what the lens itself reads.
`review/lens-extras/anthropic-accessibility-review.md` does it criterion by criterion.
`lens_health` in the posted review holds what each lens reported it could not check, and
`review-body.ts` adds a standing sentence for each lens in `STANDING_DETAIL`, so a review
says what it did not reach even when a lens forgets to.

## How a finding is rated

The orchestrator answers a set of bounded questions about each merged finding, under `risk`.
Each one is an enum, and `merged-schema.json` carries the question and the meaning of every
answer, written there from the `AXES` table in `risk.ts` by `scripts/build-risk-schema.ts`.
Some ask how much damage the defect does, and those answers are added; the rest ask how much
that damage counts, and those are multiplied in. `risk.ts` does the arithmetic, which ends in a
score from 0 to 100, and bands that into `critical`, `high`, `medium`, `low` or `nit`. Nothing
a model writes is a tier.

The `print-threshold` input is the lowest tier the posted comment prints in full. Everything
below it is left to `findings.json` in the run's artifact, which holds every finding with the
answers it was rated on, so a reader who disagrees with the weighting can re-score the run.
Where there is no artifact, which means a review from a session and a run that kept none, the
threshold decides nothing and the body prints every finding. `vetSuppression` asks the same
`isListed` question, to decide which findings a closed thread alone may settle, but
`post-review.ts` passes it the `REVIEW_THRESHOLD` default rather than the input, so setting
`print-threshold` moves the comment and leaves that bar where it was.

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
both: there the body prints the findings rated at `PRINT_THRESHOLD` or above and links
the artifact for the rest. By hand and under `local-post.sh` they are unset, there is no
artifact anybody could open, and the body prints every finding instead, bounded the same way.

Lenses run in parallel, so the bill grows with the number of lenses and the wall clock
barely does. Three took about 15 minutes. An earlier fourteen-lens run took 20m46s for
$36.00, returning 97 findings with no permission denials, and the 12-lens set before that
came to $31.80 in 19 minutes over a 47-file diff. Budget between
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
| `DECISIONS.md` | Why each part is built the way it is, one heading per decision. A code comment that cites one names its heading. |
| `lens-brief.md` | The half of a lens's prompt that never varies, and the body of every agent. `__SKILL_LINE__`, `__EXTRAS__` and `__SCHEMA__` are substituted. |
| `lens-extras/<lens>.md` | Text for one named lens, appended to that lens's system prompt. |
| `lens-dispatch.md` | The half that does: which diff to read. `__BASE__`, `__HEAD__`, `__RANGE__`, `__DIFF_SCRIPT__` and `__DIFF_ARGS__` are substituted. |
| `lens-schema.json` | The shape each lens returns. Prompted but not enforced, because subagents do not inherit `--json-schema`. |
| `orchestrator.md` | The orchestrator's prompt template. |
| `resolve-judge.md`, `resolve-none.md` | The two thread-resolution policies. One fills `__RESOLVE__`. |
| `merged-schema.json` | The shape the orchestrator returns. Enforced, because a script parses it. |
| `run.sh` | One review, start to finish. Both front doors call this. `run.test.ts` beside it runs it with a stub agent. |
| `finalise.ts` | What `run.sh` settles once the session has exited: the sweep over the build directory, the numbers a run that reported none still writes down, and the status the run ends on. `finalise.test.ts` beside it. |
| `build-prompts.sh` | Assembles the run's plugin and the orchestrator prompt. |
| `../scripts/render-prompt.ts` | Fills a prompt template's placeholders, and fails on one nothing filled. |
| `../scripts/validate-repo.ts` | The command around every check this repository runs on itself: argv, the run, the exit code. |
| `../scripts/checks/` | One module per check, named for the key it is listed under. `index.ts` is the registry and the one place the suite is visible; `support.ts` holds the `Failures` protocol and the parsers. |
| `local-preflight.sh` | Works out from the checkout what the workflow event would otherwise supply. |
| `local-run.sh`, `local-print.sh`, `local-post.sh` | What `/codeferret:review` runs, so a session pastes no paths and relays no refs. |
| `defaults/` | The `lenses` and `exclude-paths` defaults as plain lists, for a session that cannot read a YAML default. Generated from action.yml. |
| `artifact.ts` | The name and retention window the action's upload step declares, for the run that reads an artifact back. Generated from action.yml. |
| `standing-detail.ts` | What a review says a lens could not reach, whatever that lens reported. Generated from the `standing-detail` frontmatter of `lens-extras/*.md`. |
| `versions.sh` | The bun and Claude Code versions a review runs on, sourced by both the action and the lint workflow. |
| `fetch-existing.ts` | Reads the discussion already on the pull request, for the orchestrator to match findings against. |
| `fetch-previous.ts` | Reads the previous run's findings out of its artifact, which is the other half of that match. |
| `previous.ts` | Which artifact that is and what it holds, with `previous.test.ts` beside it. |
| `unzip.ts` | Reads one file out of an artifact's zip, with `unzip.test.ts` beside it. |
| `extract-findings.ts` | The command that reads a run log: argv, the writing, the printing and the exit codes. |
| `run-log.ts` | How a log is read, which of its `result` messages is the complete one, what a run cost and why one ended. `run-log.test.ts` beside it. |
| `summary.ts` | Renders those numbers into the action's job summary. |
| `check-findings.ts` | The command that checks those findings before anything posts them: argv, printing, the write-back and the exit code. |
| `finding-rules.ts` | What may be wrong with a findings file and what to do about each thing, as functions over a parsed value. `finding-rules.test.ts` beside it. |
| `post-review.ts` | Renders the review body, posts it, and records that it landed. |
| `review-body.ts` | The rendering behind it: the sections, the length budget and the cut. `review-body.test.ts` beside it. |
| `caveats.ts` | What a run says about itself (how much it covered, what it could not reach, why a suppression was reopened), in the words a posted review and a printed one both use. |
| `words.ts` | The inflection those sentences need, kept apart from the renderer so the two do not import each other. |
| `print-findings.ts` | The same findings for a terminal, which is what a session shows instead of a posted review. |
| `risk.ts` | The axes a finding is rated on, what each answer is worth, and the arithmetic from answers to a score and a tier. `risk.test.ts` beside it. |
| `../scripts/build-risk-schema.ts` | Writes the `risk` block of `merged-schema.json` from those axes, so a model is offered the values the scorer recognises. |
| `findings.ts` | What a run produced: the shape, how a finding ranks, which ones the body prints, and which suppressions hold. Pure, so nothing importing a rule imports a module that can read a file or end the process. `findings.test.ts` beside it. |
| `read-run.ts` | The files a posted review and a printed one both read, so the two cannot decide differently what an unreadable one means. |
| `existing.ts` | The shape of `existing.json` and the one walk over it, so no reader declares its own. |
| `run-files.ts` | The names a run writes its numbers under, which action.yml and summary.ts both read back. |
| `markdown.ts` | Where a fenced block starts and stops, and what a model's prose may open in a posted review. `markdown.test.ts` beside it. |
| `reviewed-commit.ts` | Prints the commit the lenses read, for whoever is about to post against it. |
| `diff-args.ts` | Reads back what the lenses were told to diff, so nothing builds a second range or pathspec. |
| `artifact-path.ts` | What `artifact-path` names: the paths the upload step is given, and whether the findings go up with them. `artifact-path.test.ts` beside it. |
| `github.ts` | How these scripts talk to GitHub: the token handshake, the headers, the shape of a failure. |
| `json.ts` | The narrowings every script here takes on a value it did not produce. |
| `lines.ts` | A newline-separated input as trimmed lines, which its readers each used to work out for themselves. |
| `select-lenses.ts` | The lenses a run dispatches, after the exclusions. `select-lenses.test.ts` beside it. |
| `test-fixtures.ts` | The one finding the suites build their cases out of, typed and untyped. |
| `lib.sh` | What a shell script must work out or refuse before passing a value on: the guards, the `gh` handshake, the pull request and the base ref. |
| `refuse-fork.sh` | The action's first step: whether the commit this run would review is this repository's. `refuse-fork.test.ts` beside it. |

## Why it is built this way

Each decision came from a failed run, and each is written up in
[`DECISIONS.md`](DECISIONS.md) beside this file. A code comment that cites one names its
heading, so `"The reviewed tree does not configure the session" in review/DECISIONS.md` is a
heading to search for there.

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
the run's plugin and the diff command each lens is handed. The
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
posting inline comments, prints in the body only the findings at the print threshold and above,
and uses `actions: read`, which an older workflow does not grant. Every one of those degrades
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
