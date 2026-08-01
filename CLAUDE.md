# CodeFerret

CodeFerret reviews a diff through several independent code review skills ("lenses") at
once, then merges their findings into one review with inline comments.

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
change, what to run, and the traps. [`review/README.md`](review/README.md) has the rest —
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
*outside* the reviewed diff, so a finding against it exercises the out-of-diff anchoring
path. Leave it alone.

The scoring key lives outside the repository. Do not add it. A reviewer that can read
the answers cannot be measured.

Fixture values that look like real credentials must not match a real provider's
detectable format. Use an obviously invented prefix. GitHub push protection blocked a
branch once over a fake `sk_live_...` Stripe key.

## Before you push

```sh
bun scripts/validate-manifests.ts
bun run typecheck
```

GitHub validates workflow syntax when you push, but it does not validate an action
manifest until a run loads it. So nothing catches a broken `action.yml` until the first
step of a real review fails. That is how an unquoted `pull-requests: write` inside an
input description shipped once. Quote any string that contains `: `.

## Things that will bite you

Each of these is a rule and the one fact that makes it stick. `review/README.md` carries
the arguments behind them.

- **A lens's `in_diff` field is unreliable.** On every run so far, a lens reported an
  out-of-diff finding as in-diff. `post-review.ts` checks each line against the diff
  hunks instead of the lens's claim. Do not remove that check: the review API is atomic,
  so a single bad anchor fails the whole request with 422 and no comments are posted.
- **Do not ask the orchestrator for counts.** It narrated "27 by three lenses" when the
  answer was 31. `post-review.ts` computes totals, quorum, and severity spread.
- **A lens that returns zero findings is probably broken.** One spent $1.28, exited 0,
  and emitted nothing after a complete and correct review. Every finding must go through
  the structured output, and the posted review carries `lens_health` so a dead lens shows
  up as a number. The one exception is a lens that returns nothing *and* names a checkable
  reason, which the orchestrator reads against the diff; do not widen it to zero findings
  with no reason given.
- **The lens's prompt must state the base ref.** It travels in `review/lens-dispatch.md`.
  Without it, some lenses stop and ask which commit to diff against, and nothing can
  answer in a headless run.
- **Subagents do not inherit `--json-schema`.** Their schema comes from the prompt, so
  do not trust the shape of lens output. Only the orchestrator's output is validated.
- **Text for one lens goes in that lens's own prompt, not the orchestrator's.**
  `review/lens-extras/<lens>.md` is rendered into that agent's system prompt, and
  `review/lens-dispatch-extras/<lens>.md` travels with the dispatch when the text depends
  on the run. Routed through the orchestrator instead, the routing is a judgement remade
  every run and nothing downstream can tell when it went wrong. `REVIEW.md` goes to
  `mattpocock-code-review` alone; do not broaden it to every lens.
- **Do not put severity or lens agreement into a comment.** Both are in `findings.json`
  and severity orders the findings, but neither is displayed. For the same reason, do not
  add severity filtering.
- **A cap on tool input is not that filtering.** `review/tools/*` cap what they hand the
  lens at 100 findings, sorted so the cap takes the low end. That bounds what one lens is
  asked to read, not what a reader is told: everything raised stays in
  `build/tool-*.json`. Cap the input, never the findings. `post-review.ts` caps the
  comments too, at 40, because GitHub refuses a review carrying more; the rest go into the
  body, where the reader still sees every one.
- **Lenses must not modify the working tree.** Every lens reads the same checkout at once,
  so one edit corrupts every other lens's review. `Edit`, `Write`, `NotebookEdit` and
  `Agent` are all kept off the tool list in `agents/`, and the action denies them at the
  CLI as well. None of it is a guarantee (a lens has `Bash`), so keep the instruction in
  `review/lens-brief.md` too.
- **No lens is handed a way to reach the network.** `WebFetch` and `WebSearch` are off the
  tool list on purpose: a lens reads an untrusted diff with `CLAUDE_CODE_OAUTH_TOKEN` in
  its environment. This raises the cost of exfiltration rather than preventing it, since
  `Bash` still has `curl`.
- **A tool an agent asks for is not necessarily a tool it gets, and nothing says so.**
  `Grep`, `Glob`, and `TodoWrite` were all in the lens tool list and none reached a
  dispatched lens. Reading the list will not tell you, so check it against a real dispatch
  when you change it: `claude -p '...' --plugin-dir .`, asking an agent to name its tools.
- **Suppression can hide a real finding.** The orchestrator marks each finding `new`,
  `already-reported`, or `declined`, and only `new` gets posted. It is told to choose
  `new` whenever it is unsure. If you tighten that, you trade duplicate comments for
  findings nobody sees. `findings.json` in the `codeferret-run` artifact holds every
  finding with its status, including the hidden ones.
- **Resolving a thread is a judgement, not a rule.** `isOutdated` is evidence the
  orchestrator weighs, not a gate: a fix landing elsewhere leaves a thread current, and an
  unrelated edit above one makes a live thread outdated. Do not turn it back into a
  condition.
- **A reply cannot make a security defect safe.** The carve-out is written into
  `orchestrator.md`, because "this is intentional" on a vulnerability would otherwise
  silence it for good. Keep it if you touch the decline rules.
- **`post-review.ts` reads the pathspec back out of `build/diff-args`.** It used to build
  its own, the two drifted, and the anchor map then covered files no lens had read. Do not
  reintroduce a second construction of it.
- **The action posts on `findings-checked`, not on the findings file existing.** A
  findings file that fails `check-findings.ts` produces a comment with no line, and GitHub
  answers 422 for the whole review.

## Accepted risks

Each of these is real, has been weighed, and stands. A review keeps finding them, because
a lens reads the code rather than this file. Check here before acting on one.

- **Mutable version references, `@v1` above all.** The template and the README point
  consumers at `pocketarc/codeferret@v1`, which this repository moves on every release. A
  tag anyone can repoint is a supply-chain risk and the tooling is right to say so. It is
  also the whole distribution mechanism: pinning by SHA would mean every consumer editing
  a workflow to get a fix. Anyone who wants the guarantee can pin `@v1.0.0`.
- **A lens can read `CLAUDE_CODE_OAUTH_TOKEN`.** It runs with `Bash`, the token is in the
  environment it inherits, and `run.json` goes into an artifact that is not secret-masked.
  On a private repository, whoever can read that artifact could run the action anyway.
  This is the one to revisit before pointing CodeFerret at a public repository: narrow the
  artifact's `path`, or drop the upload.
- **Anyone who can comment can decline a finding.** The orchestrator reads every comment
  whoever wrote it, so on a public repository a stranger's "working as intended" suppresses
  a finding on later runs. Deliberate: the alternative is ignoring a maintainer's reply
  because it came from the wrong account. A reply still cannot make a security defect safe.
- **Two lenses ship without the capability their skills describe.**
  `copilot-web-design-reviewer` has no browser and `anthropic-accessibility-review` cannot
  render a page. Both stay in the default set: measured over two runs they produced five
  unique findings, including the one that was rendering every finding body as a code
  block. `review/lens-extras/` tells each what it cannot do.
- **semgrep fetches its ruleset at run time.** `--config p/default` is not pinned, so what
  the tool looks for can change between two runs of the same commit. The rules are
  declarative YAML rather than code, and `SEMGREP_CONFIG` points at a local set for anyone
  who wants to close it.
