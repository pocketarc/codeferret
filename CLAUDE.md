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
change, what to run, and the traps. [`review/README.md`](review/README.md) has the rest:
how a run works and why each part is built the way it is, how to add a lens, how to run a
review by hand, and how to release.

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
the diff, and the lenses spent the run's budget reviewing themselves instead of the
fixture.

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
section is gone and the file still earns its place: it is what catches a lens that stops
at the diff boundary. Leave it alone.

The scoring key lives outside the repository. Do not add it. A reviewer that can read
the answers cannot be measured.

Fixture values that look like real credentials must not match a real provider's
detectable format. Use an obviously invented prefix. GitHub push protection blocked a
branch once over a fake `sk_live_...` Stripe key.

## Before you push

`lefthook.yml` runs all of this, so a push that would go red in CI fails here first, and
the first three fail at commit time. `bun install` puts the hooks in place: lefthook is a
dev dependency and `prepare` runs `lefthook install`.

```sh
bun install
```

By hand, or to see one on its own:

```sh
bun scripts/validate-manifests.ts   # also both generators, and action.yml's shell
bun run typecheck
shellcheck -e SC2016 review/*.sh scripts/*.sh
bun test
```

GitHub validates workflow syntax when you push, but it does not validate an action
manifest until a run loads it. So nothing catches a broken `action.yml` until the first
step of a real review fails. That is how an unquoted `pull-requests: write` inside an
input description shipped once. Quote any string that contains `: `.

## Things that will bite you

Each of these is a rule and the one fact that makes it stick. The argument behind each one
is in `review/README.md`.

- A lens's `in_diff` field is unreliable, and nothing reads it. On every run that used
  inline comments, a lens reported an out-of-diff finding as in-diff. Nothing anchors to a
  line now, so there is nothing left to be wrong about. Whoever adds the first inline
  comment back has to restore the check that caught it.
- Do not ask the orchestrator for counts. It narrated "27 by three lenses" when the
  answer was 31. `post-review.ts` and `review-body.ts` compute every count in the body.
- A lens that returns zero findings is probably broken. One spent $1.28, exited 0,
  and emitted nothing after a complete and correct review. Every finding must go through
  the structured output, and the posted review carries `lens_health` so a dead lens shows
  up as a number. The one exception is a lens that returns nothing *and* names a checkable
  reason, which the orchestrator reads against the diff. Do not widen it to zero findings
  with no reason given.
- The lens's prompt must state the base ref. It travels in `review/lens-dispatch.md`.
  Without it, some lenses stop and ask which commit to diff against, and nothing can
  answer in a headless run.
- Subagents do not inherit `--json-schema`. Their schema comes from the prompt, so
  do not trust the shape of lens output. Only the orchestrator's output is validated.
- Text for one lens goes in that lens's own prompt, not the orchestrator's.
  `review/lens-extras/<lens>.md` is rendered into that agent's system prompt. Routed through
  the orchestrator instead, the routing is a judgement remade every run, and nothing
  downstream can tell when it went wrong.
- Do not put severity or lens agreement into a comment, and do not filter on either.
  Both are in `findings.json`, and severity orders the findings and decides which ones the
  comment prints in full. Every finding stays in the file whatever the comment prints.
- `review/tools/*` cap what they hand the lens at 100 findings, sorted so the cap takes
  the low end, and everything a tool raised stays in `build/tool-*.json`. Cap what a lens
  reads; the findings themselves are kept whole.
- Lenses must not modify the working tree. Every lens reads the same checkout at once,
  so one edit corrupts every other lens's review. `Edit`, `Write`, `NotebookEdit` and
  `Agent` are all kept off the tool list in `agents/`, and `run.sh` denies the first three
  at the CLI as well, so a subagent a lens spawns inherits the denial. `Agent` cannot be
  denied there: STEP 1 of the orchestrator prompt dispatches every lens with it. None of
  this is a guarantee, because a lens has `Bash`, so keep the instruction in
  `review/lens-brief.md` too.
- The reviewed tree does not configure the session that reviews it. `run.sh` passes
  `--setting-sources user`. Without it the branch's own `CLAUDE.md` reaches the model, and a
  `SessionStart` hook declared in its `.claude/settings.json` runs under
  `bypassPermissions`, as whoever pushed that branch wrote it. The flag takes the branch's
  `.claude/skills/` with it, which is why `build-prompts.sh` copies a workspace lens's skill
  into the run's plugin.
- No lens is handed a way to reach the network. `WebFetch` and `WebSearch` are off the
  tool list on purpose: a lens reads an untrusted diff with `CLAUDE_CODE_OAUTH_TOKEN` in
  its environment. This raises the cost of exfiltration rather than preventing it, since
  `Bash` still has `curl`.
- A tool an agent asks for is not necessarily a tool it gets, and nothing says so.
  `Grep`, `Glob`, and `TodoWrite` were all in the lens tool list and none reached a
  dispatched lens. Reading the list will not tell you, so check it against a real dispatch
  when you change it: `claude -p '...' --plugin-dir .`, asking an agent to name its tools.
- Suppression can hide a real finding. The orchestrator marks each finding `new`,
  `already-reported`, or `declined`, and only `new` gets posted. It is told to choose
  `new` whenever it is unsure. If you tighten that, you trade duplicate comments for
  findings nobody sees. `findings.json` in the `codeferret-run` artifact holds every
  finding with its status, including the hidden ones.
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
  `fetch-previous.ts` skips any artifact without it and takes the run before instead. A
  cancelled run, a 502, a token without `pull-requests: write`, and `post: 'false'` all
  upload a findings file for a review nobody ever saw. Do not treat an artifact as evidence
  on its own. A run that found nothing new writes the record too, with no url: it posted
  nothing because the last review still stood, and without a record ten quiet pushes put
  that review past the ten artifacts `fetch-previous.ts` opens.
- An artifact is only evidence if this repository's own run produced it. A
  `pull_request` run uses the workflow files as the pull request has them, so a fork's copy
  runs and what it uploads is stored here and listed here, under a branch name its author
  chose. `fetch-previous.ts` requires the producing run's two repository ids to match,
  which no fork run can manage.
- Resolving a thread is a judgement the orchestrator makes, weighing `isOutdated` against
  the diff as one piece of evidence. `post-review.ts` then refuses any thread
  `fetch-existing.ts` did not mark `mine`, and that mark takes both a login and a comment
  shape. `fetch-existing.ts` says why neither counts alone. Loosen either half and anyone
  who can comment can hand this run a thread to close.
- A reply cannot make a security defect safe. The carve-out is written into
  `orchestrator.md`, because "this is intentional" on a vulnerability would otherwise
  silence it for good. Keep it if you touch the decline rules.
- Only an owner, a member or a collaborator can decline a finding, and `post-review.ts`
  decides that again rather than trusting the orchestrator's answer. This was an accepted
  risk until a lens read the code. The acceptance rested on there being no way to tell a
  maintainer's reply from a stranger's, and `authorAssociation` had been sitting in
  `existing.json` unread the whole time. The rule is in `orchestrator.md` for the
  orchestrator and in `vetDeclines` for the run, because the orchestrator holds that rule
  and the comments it judges as text in one context, and prose is not a boundary. A
  decline names the comment it rests on, and one that cannot be traced to an entitled
  commenter or a resolved thread goes back to `new`. Every decline is reopened when
  `existing.json` cannot be read: a repeated comment costs less than a finding nobody sees.
- Whatever needs the range or the pathspec reads `build/diff-args`. `post-review.ts`
  built the pathspec itself once, the two drifted, and the anchor map then covered files no
  lens had read. `review/diff-args.ts` holds the one reader and the one rule for getting the
  reviewed commit back out of the range. Do not reintroduce a second construction of either.
- The action posts on `findings-checked`, not on the findings file existing.
  `check-findings.ts` repairs what has one right answer, keeps what `post-review.ts`
  survives, and drops only a finding with nothing left to render, so the run can end red and
  the review still land. A file that fails it outright holds nothing worth posting.

## Nothing has shipped

`v1` and `v1.0.0` are tags with no release behind them. There are no forks, no stars and no
consumers, so nothing outside this repository reads the action, the template or an artifact
a run wrote. A breaking change costs a maintainer one edit until that stops being true.

So do not weigh backwards compatibility here, and do not write a migration for an old
shape: there is no old shape anywhere but in this repository's own history. Change the
thing, change what reads it, and say so. This section goes when the first consumer arrives.

## Accepted risks

Each of these is real, has been weighed by a maintainer, and stands. A review keeps
finding them, because a lens reads the code and not this file. Read this section before
acting on one.

- Mutable version references, `@v1` above all. The template and the README point
  consumers at `pocketarc/codeferret@v1`, which this repository moves on every release. A
  tag anyone can repoint is a supply-chain risk, and a review raises it every run,
  correctly. It is also the whole distribution mechanism: pinning by SHA would mean every
  consumer editing a workflow to get a fix. Anyone who wants the guarantee can pin
  `@v1.1.0`.
- A lens can read `CLAUDE_CODE_OAUTH_TOKEN`. It runs with `Bash` and the token is in the
  environment it inherits. The shipped template uploads `findings.json` alone, so nothing
  the session wrote about itself leaves the runner by that route. This repository's own
  workflow keeps the wide artifact path, because the fixture runs are what a maintainer
  reads when a review goes wrong.
- The orchestrator runs under `bypassPermissions` with `Bash`, holding comments written by
  anyone who can comment. `--disallowed-tools` takes `Edit`, `Write`, `NotebookEdit`,
  `WebFetch` and `WebSearch`; `Bash` and `Agent` stay, because the run needs git and the
  dispatch. `orchestrator.md` frames that text as input rather than instruction, and prose
  is not a boundary. It stands because a runner is disposable and a classifier that refused
  the orchestrator halfway would lose a review that cost $36. `/codeferret:review` runs
  under `auto` instead, on a machine that is not disposable.
- Two lenses ship without the capability their skills describe.
  `copilot-web-design-reviewer` has no browser and `anthropic-accessibility-review` cannot
  render a page. Both stay in the default set: measured over two runs they produced five
  unique findings, including the one that was rendering every finding body as a code
  block. Each has a file under `review/lens-extras/` saying what it cannot do.
- semgrep fetches its ruleset at run time. `--config p/default` is not pinned, so what
  the tool looks for can change between two runs of the same commit. The rules are
  declarative YAML rather than code, and `SEMGREP_CONFIG` points at a local set for anyone
  who wants to close it.
