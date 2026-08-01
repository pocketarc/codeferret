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

For why each part is built the way it is, see [`review/README.md`](review/README.md).
This file is about working in the repository.

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
*outside* the reviewed diff, which is what exercises the out-of-diff anchoring path.
Leave it alone.

The scoring key lives outside the repository. Do not add it. A reviewer that can read
the answers cannot be measured.

Fixture values that look like real credentials must not match a real provider's
detectable format. Use an obviously invented prefix. GitHub push protection blocked a
branch once over a fake `sk_live_...` Stripe key.

## Before you push

```sh
bun scripts/validate-manifests.ts
```

GitHub validates workflow syntax when you push, but it does not validate an action
manifest until a run loads it. So nothing catches a broken `action.yml` until the first
step of a real review fails. That is how an unquoted `pull-requests: write` inside an
input description shipped once. Quote any string that contains `: `.

## Running a review locally

Normally you want `/codeferret:review`. That is what the plugin is for, and it handles
the base ref, the pathspec, and an uncommitted working tree for you.

Underneath, both it and the action call `review/run.sh`, so you can run exactly what CI
runs from a checkout of the branch you want reviewed:

```sh
LENSES=$'caveman-review\nsentry-security-review' \
  EXCLUDE_PATHS="$(cat review/defaults/exclude-paths.txt)" \
  bash review/run.sh test/fixture "$PWD" "$(mktemp -d)/codeferret" "$PWD"
```

`run.sh` has no default for `EXCLUDE_PATHS`, so leaving it out gives the lenses no
exclusions at all rather than CI's, and they spend the run's budget reading lockfiles and
build output.

`PERMISSION_MODE` defaults to `bypassPermissions`, which is what CI passes. Pass `auto`
to run it the way `/codeferret:review` does: a lens gets the reads it needs, anything
else is refused, and refusals are counted in `build/permission-denials` rather than
disappearing. The header of `run.sh` lists the rest.

The plugin `run.sh` builds is also called `codeferret`, and so is the installed one. That
is fine: `--plugin-dir` wins the namespace and shadows the installed copy, which is what
you want, because the built one holds exactly the lenses this run asked for. An earlier
note here said two plugins cannot share a name in one session and told you to disable the
installed one first. That was never tested and it is wrong.

Print the review without posting it:

```sh
DRY_RUN=1 GITHUB_TOKEN=x GITHUB_REPOSITORY=pocketarc/codeferret \
  EXCLUDE_PATHS="$(cat review/defaults/exclude-paths.txt)" \
  bun review/post-review.ts "$RT/codeferret/build/findings.json" \
  test/fixture test/fixture-defects 1
```

Give it the same `EXCLUDE_PATHS` the lenses were given, or a finding can anchor to a file
they never saw.

Budget roughly 15 minutes and several dollars per run on Opus with three lenses. Lenses
run in parallel, so adding more of them costs money rather than time: the full fourteen,
with both static analysis tools, came to $36.00 in 20m46s and returned 97 findings, with
no permission denials. The twelve-lens set before them came to $31.80 in 19 minutes over
a 47-file diff.

`extract-findings.ts` prints that cost, and the action puts it in the job summary and in
its `cost-usd` and `output-tokens` outputs. Read `modelUsage` in `run.json` if you want
the breakdown; the `usage` object beside it covers the orchestrator's last turn alone and
undercounts a twelve-lens run sixtyfold.

## Adding a lens

To bundle a skill with the action, vendor it at a pinned commit:

```sh
bash scripts/vendor-lens.sh <repo> <commit-sha> <in-repo-subdir> <local-name>
```

Then add `<local-name>` to the `lenses` default in `action.yml` and to
`review/defaults/lenses.txt`, render its agent with
`bun scripts/build-lens-agents.ts`, and run `bun scripts/validate-manifests.ts`. The
validator checks those three against each other, so it will tell you which one you
forgot.

To use a skill in one repository only, put it under the consuming repository's own
`.claude/skills/<name>/` and name it in the action's `lenses` input. If a named lens has
no `SKILL.md` in either place, `build-prompts.sh` fails.

Never fetch a skill at run time: a review job holds a `pull-requests: write` token, so
everything it executes should be reviewable and should not change between runs.
`lenses/skills/PROVENANCE.tsv` records the upstream repository, commit, and path for
each bundled lens.

`vendor-lens.sh` rewrites four frontmatter fields, because a vendored skill is not used
the way its author intended:

- `name` becomes the local directory name. All bundled lenses share one plugin
  namespace, and more than one upstream ships a skill called `security-review`.
- `description` is replaced with a scoped one, so that fourteen lenses do not put
  themselves in front of the model during unrelated work. Nothing downstream reads it: a
  lens agent is told which skill to load by name. `review/README.md` has the argument.
- `disable-model-invocation: true` is removed. It leaves a skill reachable only by a
  person typing its slash command, and a lens agent loads its skill through the Skill
  tool, which is model invocation. `cursor-thermo-nuclear-review` shipped with it, and
  left in it would have cost one lens with nothing to show for it but a healthy run.
- `user-invocable: false` is removed, which keeps `/codeferret:<lens>` available for
  running one lens by hand. An earlier version of this note said a skill carrying that
  flag never registers. That is wrong on 2.1.220: it registers, the model still sees it,
  and all the flag does is hide the menu entry. So do not add it back to tidy the slash
  menu. The scoped description is what keeps a lens out of unrelated work.

## Releasing

Consumers pin `pocketarc/codeferret@v1`. GitHub resolves that as a plain git ref, not a
semver range, so `v1` is a mutable tag this repository moves on every release. Skip the
move and every consumer stays on the previous revision with no sign anything happened.

```sh
git push origin main
git tag -a v1.2.0 -m "CodeFerret 1.2.0"
git tag -f v1 -m "CodeFerret v1"
git push origin v1.2.0
git push --force origin v1
```

A change that breaks a consumer's workflow — a new required input, a permission they now
have to grant, work moved out of the action and into their job — needs `v2` and a `v2`
tag, because `@v1` carries it to everyone the moment the tag moves.

Bump `version` in `.claude-plugin/plugin.json` to the same number in the same commit.
Plugin users see it in `/plugin`, and it is the only version they are shown.

Plugin users are not on tags at all. `/plugin marketplace add pocketarc/codeferret`
follows this repository's default branch, and `/plugin update` gives them whatever is on
it. So nothing reviews or approves what lands on `main` before plugin users get it: they
get whatever is there the moment it lands, while an action consumer sees nothing until
`v1` moves. Keep `main` releasable.

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
- **`REVIEW.md` goes to `mattpocock-code-review` and to nothing else.** It travels in
  `review/lens-extras/mattpocock-code-review.md`, appended to that one agent's system
  prompt. Anything else meant for a single lens belongs there too, rather than in a line
  the orchestrator has to route correctly every run. Do not broaden it to every lens.
- **Do not put severity or lens agreement into a comment.** Both are in `findings.json`
  and severity orders the findings, but neither is displayed. For the same reason, do not
  add severity filtering.
- **Bounding a tool's output is not that filtering.** `review/tools/semgrep.ts` caps what
  it hands the lens at 100 findings. That bounds what one lens is asked to read, not what
  a reader is told: everything raised stays in `build/tool-*.json`. Bound the input, never
  the findings.
- **Lenses must not modify the working tree.** Every lens reads the same checkout at once,
  so one edit corrupts every other lens's review. `Edit`, `Write`, `NotebookEdit` and
  `Agent` are all kept off the tool list in `agents/`, and the action denies them at the
  CLI as well. None of it is a guarantee — a lens has `Bash` — so keep the instruction in
  `review/lens-brief.md` too.
- **No lens is handed a way to reach the network.** `WebFetch` and `WebSearch` are off the
  tool list on purpose: a lens reads an untrusted diff with `CLAUDE_CODE_OAUTH_TOKEN` in
  its environment. This raises the cost of exfiltration rather than preventing it, since
  `Bash` still has `curl`. Before pointing this at a public repository, narrow the
  artifact's `path` or drop the upload: `run.json` is not secret-masked.
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
- **A reply cannot make a security defect safe.** `orchestrator.md` says so explicitly,
  because "this is intentional" on a vulnerability would otherwise silence it for good.
  Keep that carve-out if you touch the decline rules.
