# CodeFerret

CodeFerret reviews a diff through several independent code review skills ("lenses") at
once, then merges their findings into one review comment.

There are two ways to run it. As a GitHub composite action (`action.yml`) it reviews
a pull request and posts the review. As a Claude Code plugin it adds `/codeferret:review`,
which reviews the branch in front of you, in the session you are already in. The
repository root is the plugin root: `.claude-plugin/` holds both manifests, `commands/`
holds the slash commands, `agents/` holds one generated agent per lens, and the skills
stay where they were under `lenses/skills/`.

The action and the command both render their prompts with `review/build-prompts.sh` and
dispatch the same agents, so a change to how a review works lands in both. Keep it that
way.

This file is the part to get right before touching anything: which branch, what never to
change, what to run, and the traps. [`review/README.md`](review/README.md) has the rest: how
a run works, how to add a lens, how to run a review by hand, and how to release.
[`review/DECISIONS.md`](review/DECISIONS.md) beside it has why each part is built the way it
is, one heading per decision.

## Branches

| Branch | Contents | Rule |
|---|---|---|
| `main` | The action and bundled lenses. Nothing else. | Tool changes go here. |
| `test/fixture` | A clean fixture application, plus the coding standards and issue spec a review is scored against. | Never merge. |
| `test/fixture-defects` | Branched from `test/fixture`, adding deliberate defects. | Never merge. |

Both `test/` branches are permanent, disposable fixtures whose only purpose is to be
reviewed.

**Never commit a tool change to a `test/` branch.** The reviewed diff is
`test/fixture...test/fixture-defects`, so anything you add there becomes part of what
the lenses review. This has already happened once: the whole action ended up inside
the diff, and the lenses spent the run's budget reviewing themselves.

To get a tool change onto the fixture branches, first commit it to `main`. Then rebase
both:

```sh
git rebase main test/fixture
git rebase test/fixture test/fixture-defects
```

Both branches then need a force-push. Confirm with Bruno first. Then push both with
`--force-with-lease`.

Rebase rather than merge, so each fixture branch stays "main plus one fixture commit"
and the reviewed diff stays exactly the fixture.

## Never fix the seeded defects

`test/fixture-defects` contains SQL injection, an IDOR, a hardcoded credential, path
traversal, `dangerouslySetInnerHTML` on unsanitised input, float arithmetic on money,
and more. They are all deliberate, and they are the measuring instrument. If you fix
them, there is nothing left to score a review against.

`backend/app/Support/Sanitizer.php` on `test/fixture` is a no-op on purpose. It sits
*outside* the reviewed diff, so a lens has to follow a defect out of the changed lines to
find it. That used to exercise a code path of its own as well, because a finding there
could not be anchored to a comment and went to a section of the body kept for those. The
section is gone, and the file is still worth keeping: a lens that stops at the diff
boundary never reaches it. Leave it alone.

The scoring key lives outside the repository. Do not add it. A reviewer that can read
the answers cannot be measured.

Fixture values that look like real credentials must not match a real provider's
detectable format. Use an obviously invented prefix. GitHub push protection blocked a
branch once over a fake `sk_live_...` Stripe key.

## Before you push

`lefthook.yml` runs all of this, so a push that would go red in CI fails here first.
Everything but `bun test` also fails at commit time; `lefthook.yml` is the record of which
runs where. `bun install` puts the hooks in place: lefthook is a dev dependency and
`prepare` runs `lefthook install`.

```sh
bun install
```

By hand, or to see one on its own:

```sh
bun scripts/validate-repo.ts   # also both generators, and action.yml's shell
bun run typecheck
shellcheck -e SC2016 review/*.sh scripts/*.sh
bun test
```

GitHub validates workflow syntax when you push, but it does not validate an action manifest
until a run loads it. `scripts/checks/action.ts` closes the half of that which is YAML:
it parses `action.yml` through `Bun.YAML`, lefthook runs it at commit time, and an unquoted
`Needs pull-requests: write to post it.` in an input description now fails there rather than
at the first step of a real review, which is how one shipped once. Quote any string that
contains `: ` regardless — the check reports a parse error rather than the line that caused
it. What nothing here catches is a manifest that parses and is wrong: a key GitHub does not
recognise, a step shape it refuses. Those still wait for a run.

The shell inside `action.yml` runs nowhere else, so shellcheck is all that reads it before
CI does, and shellcheck reads only syntax. A `git rev-parse --verify -- "$ref"`
shipped that way and failed every run at the fourth step: in `rev-parse`, `--` separates
revisions from paths, so the ref landed on the path side and no revision was verified.
`--end-of-options` is the marker that guards a leading dash. Run a line you changed here
against a real repository before pushing it.

Write a commit subject that names the change rather than the review that prompted it. A
reader of "Stop the two pathspecs drifting" knows what moved. A reader of "Work through
the third review" knows only that a review happened, and the ordinal means nothing to
anyone who was not counting at the time.

## Things that will bite you

Each of these is a rule and the one fact that makes it stick. The argument behind each one
is in `review/DECISIONS.md`.

- Do not write a count of what this repository holds into a comment or a document. The
  README led with "fourteen lenses" for a full round after the set became thirteen, and
  nothing failed. Name the set instead of counting it. A measurement of something that
  happened is a different thing and stays: "$1.28 and no findings" is the evidence for the
  rule beside it, and no later commit can make it wrong. Nothing mechanical catches these, so
  the `comment-review` lens is told, in `review/lens-extras/comment-review.md`, to report the
  ones that get through. That lens is currently off in this repository's own workflow, along
  with `writing-review`: the `exclude-lenses` block in `.github/workflows/codeferret.yml`
  names both, says why, and carries the date the exclusion expires;
  `checkWorkflowLenses` fails once that date has passed. While they are off, run them by hand
  over the working tree before a push, or this rule has nothing behind it. The run that first had
  them off left a stale `tool-stub.ts` row and three descriptions of a deleted stage in the
  tree, and a person found them.
- A lens's `in_diff` field is unreliable, and nothing reads it. On every run that used
  inline comments, a lens reported an out-of-diff finding as in-diff. Nothing anchors to a
  line now, so there is nothing left to be wrong about. Whoever adds the first inline
  comment back has to restore the check that caught it.
- Do not ask the orchestrator for counts. It narrated "27 by three lenses" when the
  answer was 31. `post-review.ts`, `review-body.ts` and `caveats.ts` compute every count in
  the body between them.
- A lens that returns zero findings is probably broken. One spent $1.28, exited 0,
  and emitted nothing after a complete and correct review. Every finding must go through
  the structured output, and the posted review carries `lens_health` so a dead lens shows
  up as a number. The one exception is a lens that returns nothing *and* names a checkable
  reason, which the orchestrator reads against the diff. Do not widen it to zero findings
  with no reason given.
- The base ref belongs in the lens's prompt, and `review/lens-dispatch.md` holds it.
  Without it, some lenses stop and ask which commit to diff against, and nothing can
  answer in a headless run.
- Subagents do not inherit `--json-schema`. Their schema comes from the prompt, so
  do not trust the shape of lens output. Only the orchestrator's output is validated.
- Text for one lens goes in that lens's own prompt, not the orchestrator's.
  `review/lens-extras/<lens>.md` is rendered into that agent's system prompt. Routed through
  the orchestrator instead, the routing is a judgement remade every run, and nothing
  downstream can tell when it went wrong.
- Do not put lens agreement into a comment, and do not filter on it. It shows how
  conspicuous a defect is, not how much it matters: on a ten-lens run the most-corroborated
  finding was a cache-key nit that six lenses spotted, while the missing index, the RSC
  boundary violation and the keyboard-access failure were each found by one. `found_by`
  stays in `findings.json`, where an agent can read it.
- A finding below `print-threshold` is in `findings.json` and nowhere a person will read it.
  `review/risk.ts` scores the risk answers the orchestrator gave a finding and bands the score
  into a tier, and `isPrinted` compares that tier against `print-threshold` on a run that keeps
  an artifact to leave the rest to. Where there is no artifact to send a reader to (a session,
  or a run that kept none), the body prints every finding instead and the threshold decides
  nothing. The body leads the listing with how many of the run's findings it is showing, so a
  reader knows the page is partial, and says nothing about what the rest were: a count is not a
  title, and somebody scanning the comment cannot tell four findings from four with thirty
  behind them worth reading. "A finding shows the claim and nothing else" in
  `review/DECISIONS.md` has what the trade costs.
- Lenses must not modify the working tree. Every lens reads the same checkout at once,
  so one edit corrupts every other lens's review. `Edit`, `Write`, `NotebookEdit` and
  `Agent` are all kept off the tool list in `agents/`, and `run.sh` denies the first three
  at the CLI as well, so a subagent a lens spawns inherits the denial. `Agent` cannot be
  denied there: STEP 1 of the orchestrator prompt dispatches every lens with it. None of
  this is a guarantee, because a lens has `Bash`, so keep the instruction in
  `review/lens-brief.md` too.
- Every `bun` a review starts takes `--config=/dev/null`. Bun runs the `preload` script
  that the `bunfig.toml` in its working directory names, before the script on the command
  line, and moving the working directory out of the checkout only moves the problem: the
  orchestrator has `Bash` under `bypassPermissions` and its prompt names `$BUILD`, so it can
  write that file into every directory a run has left to stand in. `validate-repo.ts` reads
  `review/*.sh`, `scripts/*.sh` and `action.yml` for a `bun` that names a script without the
  flag, including the ones inside printed hints, and fails on one. Both script directories:
  `scripts/vendor-lens.sh` runs bun too, and it sat outside the scanned set, which is how it
  came to run without the flag.
- No file the session could have written is evidence about the session. `run.sh` replaces
  the `existing.json` the orchestrator was given with the empty form, because the
  orchestrator holds that path in the same prompt as the rule `vetSuppression` applies, and
  it could write the file its own suppressions are then checked against. `fetch_existing` in
  `lib.sh` puts a real one back, called from the post and print paths rather than from
  `run.sh`: the token would have to come back into the script that started the agent to be
  used there, and by then `bun` and the action's own scripts are files that session has had a
  whole review to replace. The refetch costs one extra pair of API calls and picks up
  whatever was said during the run. `previous.json` gets the same treatment and used to get
  none: `vetSuppression` reads it through `filesRaisedBefore`, and that set is the whole of
  what settles an `already-reported` finding citing no comment, which `orchestrator.md` makes
  the ordinary case. So `run.sh` empties that file too and the action's posting step calls
  `fetch_previous` beside `fetch_existing`. The local paths do not, because `ownWorkflow`
  answers null where nothing names a workflow and every artifact is then refused.
  The run having two directories rather than one settles none of it: `--plugin-dir` is handed
  the directory both sit under, and a lens with `Bash` runs as this user. What the split buys
  is a comparison, and the digest behind it lives in `run.sh`'s own shell variables rather than
  in a file. Measured against the `cmp` that preceded it: a session that wrote identical bytes
  to both copies passed that check in silence. "The orchestrator also decides what has been said before"
  in review/DECISIONS.md has the rest.
- An input that names what a review may do has to reach the code that does it.
  `resolve-threads` reached the orchestrator's prompt and nothing else until
  `post-review.ts` was given `RESOLVE_THREADS`, and the upload step read `artifact-path`
  while `post-review.ts` never saw it, so the body went on linking an artifact nobody kept.
  Prose is not a boundary, and neither is a default.
- The reviewed tree does not configure the session that reviews it. `run.sh` passes
  `--setting-sources user`. Measured on 2.1.220 against a real dispatch: without it the branch's
  own `CLAUDE.md` reaches the model, and a `SessionStart` hook declared in its
  `.claude/settings.json` runs under `bypassPermissions`, as whoever pushed that branch wrote
  it. The flag takes the branch's `.claude/skills/` with it, which is why `build-prompts.sh`
  copies a workspace lens's skill into the run's plugin. "The reviewed tree does not configure
  the session" in review/DECISIONS.md has the rest.
- No lens is handed a way to reach the network. `WebFetch` and `WebSearch` are off the
  tool list on purpose: a lens reads an untrusted diff with `CLAUDE_CODE_OAUTH_TOKEN` in
  its environment. This raises the cost of exfiltration rather than preventing it, since
  `Bash` still has `curl`.
- `unset` cannot take a credential out of an environment. `/proc/<pid>/environ` holds what
  a process was started with for as long as it lives, and a lens runs as the same user with
  `Bash`: measured in a Linux container, an agent whose own environment was clean read
  `GITHUB_TOKEN` back out of its parent's after the shell had unset it. So the token the two
  GitHub fetches use is staged in a file by a step of its own, and `run.sh` reads it and
  deletes it before the session starts. Never put it in the `env:` of the step that execs the
  agent. "The GitHub token never enters the step that runs the agent" in review/DECISIONS.md has
  the measurement and what is left over.
- Keeping the token out of the environment kept it in the checkout. `actions/checkout`
  defaults `persist-credentials` to true, so it leaves the token it cloned with reachable from
  the workspace's own git config; `run.sh` then starts the session inside that workspace,
  and every lens has `Bash`, so a lens running `git config --get-regexp extraheader` read out
  the same token the staging step above exists to hide. Five lenses found it.
  `review/scrub-credentials.sh` removes it and reads back to check. It removes rather than
  setting `persist-credentials: false`, because a caller who checks out for themselves makes
  the probe step skip this action's own checkout, and a flag there would then cover neither
  their config nor this one. So the two fetches in "Resolve the review target" are the last
  thing in the run that can reach GitHub over git, and they sit before the scrub for that
  reason. A `git fetch` added after it fails on a private repository and passes on a public
  one, and nothing here tests for that difference.
- Prove a credential is gone by looking for a credential, not for the places one is kept.
  Three reviews found `scrub-credentials.sh` certifying a clean workspace over a live token, and
  every time the fix was right and the next shape was missed: the wrong storage mechanism
  entirely, then a token in a remote's url, then the bare `http.extraheader` key (the pattern
  wanted a middle segment) and a credential in the *key* of a `url.<base>.insteadOf` rewrite,
  then a second repository checked out beside the first that neither the sweep nor the read-back
  walked. A read-back keyed on names can only find what somebody thought of, so the one there
  now reads whole `key=value` lines out of `git config --list` and matches what a credential
  looks like. Removal still knows shapes and always will; what changed is that a shape it does
  not know now fails the step and names the key rather than passing. Keep those two apart, and
  keep the test's own check off the script's patterns: the first version of that shared them and
  went green on the shapes it was written to catch.
- A scrub that reports nothing is not evidence that there was nothing to scrub. The first
  version of that script looked for `http.<server>.extraheader` in the repository's own
  config, which is where checkout used to put the token and is not where it puts it now:
  v6.0.2 writes the header into a file under `$RUNNER_TEMP` and links it with an
  `includeIf.gitdir` in `.git/config`. `git config --local` does not expand an include, so the
  scrub matched nothing, the read-back matched nothing either, and the step exited 0 having
  done nothing at all over a live credential for a whole review. A lens reads it because a
  plain `git config --get-regexp` without `--local` does expand it. Both were measured. Two
  things follow. Verify a credential control against the config a real run produces rather than
  one planted by hand, because ten cases passed against a config no run has ever written.
  And the file matters more than the key pointing at it: it sits in `$RUNNER_TEMP`, readable
  whether or not any config still references it, so it is deleted rather than dereferenced.
- A tool an agent asks for is not necessarily a tool it gets, and nothing says so.
  `Grep`, `Glob`, and `TodoWrite` were all in the lens tool list and none reached a
  dispatched lens. Reading the list will not tell you, so check it against a real dispatch
  when you change it: `claude -p '...' --plugin-dir .`, asking an agent to name its tools.
- Suppression can hide a real finding. The orchestrator marks each finding `new`,
  `already-reported`, or `declined`, and only `new` gets posted. It is told to choose
  `new` whenever it is unsure. If you tighten that, you trade duplicate comments for
  findings nobody sees.
- The previous review is in that run's findings file. A review body is neither a review
  thread nor a conversation comment, so nothing a comment fetch returns carries it, and 60
  findings of 100 would have been posted again on every push. `fetch-previous.ts` reads the
  previous run's `codeferret-run` artifact, and matches on the pull request number
  `post-review.ts` writes into the `posted` record: a branch name is reused as soon as a
  merged branch is recreated, and one branch can head two open pull requests at once.
- The action keeps that artifact itself, and the shipped workflow grants `actions: read`.
  Both used to sit in the consumer's file, where a review repeated every finding on every
  push unless the consumer wrote an upload step with the right name and uncommented a
  permission, and the only sign of either mistake was the repetition. The name is protocol
  between the step that writes it and the run that reads it, so `artifact-path` chooses
  what goes in and nothing chooses what it is called. `fetch-previous.ts` still answers a
  missing permission with a line on stderr and an empty file, because a review must not
  depend on a permission a consumer can decline. The template grants it; a consumer who
  deletes the line still gets a review, and it repeats itself.
- Only a review that reached the pull request may suppress anything. `post-review.ts`
  writes `posted` into the findings file once GitHub has accepted the review, and
  `fetch-previous.ts` skips any artifact without it and takes the run before instead. A 502,
  a token without `pull-requests: write`, and `post: 'false'` all upload a findings file for
  a review nobody ever saw. Do not treat an artifact as evidence on its own. A cancelled run
  used to be another way in, which is why the upload step's condition is `!cancelled()`
  rather than `always()`. A run that found nothing new writes the record too, with no url:
  it posted nothing because the last review still stood, and without a record ten quiet
  pushes put that review past the ten artifacts `fetch-previous.ts` opens.
- An artifact is only evidence if this repository's own run produced it. A
  `pull_request` run uses the workflow files as the pull request has them, so a fork's copy
  runs and what it uploads is stored here and listed here, under a branch name its author
  chose. `fetch-previous.ts` requires the producing run's two repository ids to match,
  which no fork run can manage.
- Resolving a thread is a judgement the orchestrator makes, weighing `isOutdated` against
  the diff as one piece of evidence. `post-review.ts` then drops any thread
  `fetch-existing.ts` did not mark `mine`, and that mark takes both a login and a hidden
  marker. Why neither counts alone is written beside `mine` in `fetch-existing.ts`. Loosen
  either half and anyone who can comment can hand this run a thread to close. A trailing
  `<sub>` line counted as a second marker until it was measured: on a pull request carrying
  forty of this tool's own threads it matched none of them, and ordinary markup is too easy
  to reproduce to prove who wrote a comment.
- A reply cannot make a security defect safe. The carve-out is written into
  `orchestrator.md`, because "this is intentional" on a vulnerability would otherwise
  silence it for good. Keep it if you touch the decline rules.
- Only an owner or a collaborator can decline a finding, and `post-review.ts` decides that
  again for itself. `MEMBER` was among them and came out: GitHub answers it for anybody in the
  organisation that owns the repository, whether or not they hold a permission on the
  repository itself, so on one owned by a large organisation it accepted a dismissal lasting
  the life of the pull request from somebody who could not push. Narrowing it took the code and
  `orchestrator.md` in the same change, or the model would go on declining on a rule the run
  overturns every time. `authorAssociation` is still an approximation: the question is what
  permission the commenter holds here, and answering it outright means asking GitHub in
  `fetch-existing.ts`. This was an accepted risk until a lens read the code.
  The acceptance rested on there being no way to tell a maintainer's reply from a
  stranger's, and `authorAssociation` had been sitting in `existing.json` unread the whole
  time. The rule is in `orchestrator.md` for the orchestrator and in `vetSuppression` for
  the run, because the orchestrator holds that rule and the comments it judges as text in
  one context, so the run decides it a second time in code, where no comment is part of
  the input. A decline names the comment it rests on, and one that cannot be traced to an
  entitled commenter or a closed thread goes back to `new`. So does one whose comment says
  nothing about the finding's file, or the same maintainer's "LGTM" would settle every
  finding on the pull request. Every suppression is reopened when `existing.json` cannot be
  read: a repeated comment costs less than a finding nobody sees.
- A closed thread stands for its own file, no other, and not for a finding the body prints
  in full. Closing one takes repository write, or authorship of the pull request, which GitHub
  documents and a round of review caught here: on a branch from an outside contributor the
  only person who can close a thread is the one whose work is under review, so closure alone
  is not evidence that anybody with standing settled anything. It still decides a finding
  printed as one line, and `vetSuppression` holds the rest to an entitled commenter instead.
  It calls `isPrinted`, the same function the body calls, so neither can drift from the other
  about which findings the body prints in full. When each side named its own set, a finding
  graded `blocker` took the whole page and the low bar at once. `isPrinted` asks two things, and
  had to: a tier against the threshold, and whether the run has an artifact to leave the rest
  to. The tier alone described the page on a run that keeps one, and not on a run that keeps
  none, which prints everything, so a finding a reader was looking at could be settled by a
  closed thread on its own. The two are also not handed the same bar. `post-review.ts` gives
  the body the `print-threshold` input and gives `vetSuppression` whichever of that and the
  `REVIEW_THRESHOLD` default lists more findings, so raising the input cannot widen what a
  closed thread may settle and lowering it cannot leave a printed finding unprotected.
  Replying to a closed thread takes no more than commenting and does not reopen it, so a reply
  there is bound to the file the thread is anchored to and its words settle nothing. Widen
  either half and a stranger's "working as intended, `src/auth.ts` is fine" on any resolved
  thread silences any file it names.
- `already-reported` is held to a lower bar than a decline, and to more than nothing.
  Anyone's comment settles it, because a defect somebody wrote down is a defect somebody
  wrote down, and the finding keeps its line in the review either way. What it still needs
  is a comment that exists on this pull request and is about the finding's file, or an
  "LGTM" would demote the lot. Most of them cite no comment at all, because the orchestrator
  takes the status from `previous.json`. Those are held to the same bar against that file:
  the previous review has to have raised something in the finding's file, not something with
  the same title. The orchestrator is told to match the defect rather than the prose, and it
  rewrites a title every run, so an exact comparison reopened all seven suppressions of the
  run it was measured against.
- The findings file a run uploads carries the statuses `vetSuppression` decided, not the
  orchestrator's. `post-review.ts` posted the reopened finding and wrote the decline back,
  so `fetch-previous.ts` handed it to the next run as `declined` and the gate held for one
  run. Whatever else anyone adds to `markPosted`, the array it writes is the vetted one.
- Whatever needs the range or the pathspec reads `build/diff-args`. `post-review.ts`
  built the pathspec itself once, the two drifted, and the anchor map then covered files no
  lens had read. `review/diff-args.ts` holds the one reader and the one rule for getting the
  reviewed commit back out of the range. Do not reintroduce a second construction of either.
- A warning the body can raise is a warning the body prints. `COVERAGE_NOTICES` in
  `caveats.ts` keys the condition and the sentence together, and the union comes from the list
  above it, so a notice added there has a place on the page before it compiles;
  `POSTING_NOTICES` in `review-body.ts` does the same for the one thing the body says about
  its own posting. Both halves were by hand once, and each lost one: `warned` missed `limited`,
  so a pull request full of interface changes went green with no accessibility caveat, and the
  rendering missed a thread left open by anything but a permission denial. Do not restate
  either condition beside the branch that prints it.
- The action posts on `findings-checked`, not on the findings file existing.
  `check-findings.ts` repairs what has one right answer, keeps what `post-review.ts`
  survives, and drops only a finding with nothing left to render, so the run can end red and
  the review still land. A run whose findings were all dropped lands too: the `lens_health`
  block, the coverage notices and every standing caveat are still in the file, and a red job
  beside a pull request reading as clean is the pair `warned` exists to prevent. Exit 1 is for
  a file nothing can read as a run's output, which really does hold nothing worth posting.
- Read a run's findings back through `gh api`, not through `gh run download`, and never
  through a `curl` carrying the token. `gh run download` fails here with a TLS handshake
  timeout, reliably enough that it is worth not reaching for. The obvious way round it puts
  `$(gh auth token)` in `curl`'s argv, where `/proc/<pid>/cmdline` hands it to every other
  process on the machine for the life of the request, and that is the practice `stage_token`
  and `run_tool` in `lib.sh` exist to avoid. `gh api` holds the credential itself, follows
  the redirect to the signed url, and writes the same zip:

  ```sh
  ID=$(gh api "repos/pocketarc/codeferret/actions/runs/$RUN/artifacts" \
    --jq '[.artifacts[] | select(.name=="codeferret-run")] | sort_by(.created_at) | last | .id')
  gh api "repos/pocketarc/codeferret/actions/artifacts/$ID/zip" >run.zip
  ```

  `sort_by(.created_at) | last` because re-running a failed job leaves two artifacts under
  one run id, and the older one holds the findings of the run that failed.

## Nothing has shipped

`v1` and `v1.0.0` are tags with no release behind them. There are no forks, no stars and no
consumers, so nothing outside this repository reads the action, the template or an artifact
a run wrote. A breaking change costs a maintainer one edit until that stops being true.

So do not weigh backwards compatibility here, and do not write a migration for an old
shape: there is no old shape anywhere but in this repository's own history. Change the
thing, change what reads it, and say so. This section goes when the first consumer arrives.

## Accepted risks

A register of what was weighed, when it was weighed, and what would end it. Each entry is a
decision that still stands; the date is when it was taken, and the last line is the condition
that stops it standing. An acceptance with no end is one nobody is scheduled to weigh again,
and every entry here was once written that way.

- Mutable version references, `@v1` above all. **Weighed 2026-08-01.** The template and the
  README point consumers at `pocketarc/codeferret@v1`, which this repository moves on every
  release. A tag anyone can repoint is a supply-chain risk, and a review raises it every run,
  correctly. It is also the whole distribution mechanism: pinning by SHA would mean every
  consumer editing a workflow to get a fix. Anyone who wants the guarantee can pin
  `@v1.1.0`. **Lapses** at the first release that is not a drop-in replacement for the one
  before it: an input removed, or an input whose meaning changed. That is the release `@v1`
  must stop moving onto. It also lapses if more than one account can push a tag here, because
  the trade assumes the hand that repoints the tag is the hand that wrote the code.
- A lens can read `CLAUDE_CODE_OAUTH_TOKEN`. **Weighed 2026-08-01, narrowed 2026-08-15.** It
  runs with `Bash` and the token is in the environment it inherits. A lens holding `Bash`
  holds `curl` too, which is a shorter route than writing a token into a finding and waiting
  for a download. What bounds it is the condition on the shipped workflow, which runs no
  review for a fork or for anyone outside the repository. `action.yml`'s first step covers the
  fork half of that on its own, wherever the event names a head repository: the two spellings
  are `pull_request`'s and `workflow_run`'s, and `pull_request_target` is refused outright. The
  step covers neither half where the event names none, which is `issue_comment` and every
  dispatch, and it says so on stderr rather than passing quietly. The association half is the
  workflow's `if:` alone, and nothing in the action can see it. The artifact is no bound on it
  under any `artifact-path`: `findings.json` is the session's own prose, every
  title, body, summary and detail of it, published for 14 days to anyone who asks on a public
  repository. What the narrowing changed is what else goes up beside it. This repository's own
  workflow named `.`, which is the whole build directory, `existing.json` and `previous.json`
  with it, and those two are other people's comment text rather than this session's prose. It
  now names two classes and nothing else: the review's own output (`findings.json`, `run.json`
  and `lens-list.txt`) and this run's numbers (`cost-usd`, `duration-ms`, `permission-denials`
  and `findings-checked`). Both are what a maintainer reads when a review goes wrong. The
  numbers were weighed on 2026-08-15 and add nothing anybody else wrote. The list is also not a
  bound on what a run can publish, which is written out beside it in the workflow: the session
  could rewrite or symlink any path it names. **Lapses** when a lens runs
  without `Bash`, which is the day the shorter route closes and the artifact becomes the widest
  channel left. It has to be weighed again before anything carrying somebody else's words goes
  back into `artifact-path` here.
- The orchestrator runs under `bypassPermissions` with `Bash`, holding comments written by
  anyone who can comment. **Weighed 2026-08-01.** `--disallowed-tools` takes `Edit`, `Write`,
  `NotebookEdit`, `WebFetch` and `WebSearch`; `Bash` and `Agent` stay, because the run needs
  git and the dispatch. `orchestrator.md` frames that text as input rather than instruction,
  and a model can be talked out of that framing. It stands because a runner is disposable and
  a classifier that refused the orchestrator halfway would lose a review that cost $36.
  `/codeferret:review` runs under `auto` instead, on a machine that is not disposable.
  **Lapses** on a measurement anybody can take: run a full fixture review with
  `PERMISSION_MODE=auto` and read `build/permission-denials`. A run that finishes with none is
  a run `auto` would have cost nothing, and CI moves to it. Nobody is scheduled to take it,
  and that is a decision rather than an oversight: it costs a full review, it cannot share the
  Claude account with a CI run, and two attempts on 2026-09-01 were both cut off by the
  session limit. The condition stays written down because the acceptance is worth nothing
  without it — a number from a run under `bypassPermissions` says nothing here, since nothing
  can be denied under it.
- Some lenses ship without the capability their skills describe. **Weighed 2026-08-01.**
  `copilot-web-design-reviewer` has no browser and `anthropic-accessibility-review` cannot
  render a page; measured over two runs the pair produced five unique findings, including the
  one that caught every finding body being rendered as a code block.
  `vercel-next-best-practices` has no application running. They all stay in the default set,
  each with a file under `review/lens-extras/` saying what it cannot do, and an entry in
  `STANDING_DETAIL` so a reader is told even when the lens forgets. **Lapses** per lens, on
  the same kind of measurement that put it here: a lens that returns no unique finding across
  two consecutive fixture runs costs money for nothing, and comes out of the default. It
  lapses the other way too, for a lens whose capability the session gains, and then the extras
  file and the `STANDING_DETAIL` entry go rather than the lens.
