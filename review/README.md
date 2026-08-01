# How CodeFerret works

Several review skills read the same diff independently. The orchestrator then merges
their findings into a single pull request (PR) review with inline comments.

## Shape

```
orchestrator session  ──dispatch──>  one subagent per lens (parallel)
                                     each loads its skill, returns JSON
       │
       └──merge──> findings.json ──anchor check──> one PR review
```

A run is one orchestrator and N lens subagents. The orchestrator merges the findings.
`post-review.ts` checks which findings GitHub can anchor, then posts the review.

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

To add a lens for every repository that uses the action, put the skill under
`lenses/skills/<name>/` here, then run `bun scripts/build-lens-agents.ts` to give it an
agent. It loads namespaced as `codeferret:<name>`.

To add a lens for one repository only, put the skill under that repository's own
`.claude/skills/<name>/`. It loads under its bare name.

In both cases, name the lens in the action's `lenses` input:

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

Vendor each bundled skill at a pinned upstream commit. Do not fetch skills at run time.
`lenses/skills/PROVENANCE.tsv` records the source repository, commit, and path for each
one, and marks a lens written here rather than vendored as `(first-party)`. A review job
holds a `pull-requests: write` token, so you should be able to review the code it runs,
and that code should not change between runs.

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
| `lens-dispatch.md` | The half that does: which diff to read. `__BASE__`, `__HEAD__`, `__DIFF_SCRIPT__` and `__DIFF_ARGS__` are substituted. |
| `lens-dispatch-extras/<lens>.md` | Per-run text for one named lens, passed at dispatch. `__BUILD__` is substituted. |
| `lens-schema.json` | The shape each lens returns. Prompted but not enforced, because subagents do not inherit `--json-schema`. |
| `orchestrator.md` | The orchestrator's prompt template. |
| `resolve-judge.md`, `resolve-none.md` | The two thread-resolution policies. One fills `__RESOLVE__`. |
| `merged-schema.json` | The shape the orchestrator returns. Enforced, because a script parses it. |
| `run.sh` | One review, start to finish. Both front doors call this. |
| `tools/` | Static analysis run before the review. Each writes `build/tool-<name>.json`, in the shape `tools/report.ts` declares. |
| `build-prompts.sh` | Assembles the run's plugin and the orchestrator prompt. |
| `local-preflight.sh` | Works out from the checkout what the workflow event would otherwise supply. |
| `local-run.sh`, `local-post.sh` | What `/codeferret:review` runs, so a session pastes no paths. |
| `defaults/` | The `lenses`, `exclude-paths` and `tools` defaults as plain lists, for a session that cannot read a YAML default. Generated from action.yml. |
| `fetch-existing.ts` | Reads the discussion already on the pull request, for the orchestrator to match findings against. |
| `extract-findings.ts` | Reads the merged findings out of the run log. |
| `check-findings.ts` | Checks those findings against the shape `post-review.ts` reads. |
| `post-review.ts` | Anchors the findings against the diff, then posts the review. |

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
answer in a headless run, so the subagent stalls. `lens-dispatch.md` carries the ref
itself, and `lens-brief.md` carries both facts: the ref is decided, and there is nobody
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

Every push re-runs the whole review, so without this the second push posts the same 37
comments again and the pull request becomes unreadable. Matching a new finding against
an earlier comment is the same question as merging two lenses' findings: the line has
often moved, and the earlier run may have anchored somewhere else. So the orchestrator
marks each finding `new`, `already-reported`, or `declined`, and `post-review.ts` posts
only the new ones.

It reads the whole discussion, every author included. A defect a human already raised
does not need raising again, and a reply is where the answer to a finding lives: "we
don't want that" makes a finding `declined`, which the review reports separately from
the ones merely said before. Two things a reply cannot do, both in `orchestrator.md`: it
cannot make a security defect safe by asserting the code is intentional, and it cannot
settle a finding it does not address.

Two rules keep that safe. The orchestrator marks a finding `new` whenever it is unsure,
because a repeated comment costs the author seconds while a suppressed finding is one
nobody ever sees. And suppression is visible: the review body carries the count and the
run artifact carries every finding with its status, so a matcher that starts eating
findings shows up as a number rather than as silence.

An outdated comment does not count as covering anything. GitHub collapses a comment when
the line it referred to changes, so a defect that survived an edit still needs saying.

### Excluded paths are excluded in git

The `exclude-paths` input becomes a pathspec on the diff command each lens is given, so
a lockfile is not in the diff at all. `build-prompts.sh` writes that pathspec to
`build/diff-args`, and `post-review.ts` reads the same file back when it works out which
lines are anchorable, so a finding can never point at a file the lenses never saw. Two
constructions of the same pathspec drifted once and produced exactly that.

### Text for one lens goes in that lens's own prompt

A repository's own review conventions go to `mattpocock-code-review`, whose Standards
axis already enumerates documented rules, and to no other lens. Handing a whole rulebook
to every lens pushes them toward the same generalist read, and the differentiated findings
come from lenses staying inside their own domain: on a ten-lens run the RSC boundary
violation, the missing index, and the keyboard-access failure were each found by exactly
one lens. The file is named `REVIEW.md` rather than reusing `CLAUDE.md` because Claude
Code loads `CLAUDE.md` into every session automatically, which would put the conventions
in front of every lens and defeat the scoping.

It reaches that lens through `review/lens-extras/mattpocock-code-review.md`, which
`scripts/build-lens-agents.ts` renders into that one agent's system prompt. It used to
travel as a line in the orchestrator's prompt saying who to hand it to, which made the
scoping a judgement remade on every run, with nothing downstream able to tell when it went
to the wrong lens or to all of them.

Everything else meant for one lens lives there too, and the directory now carries what a
vendored skill assumes and this run cannot provide: that there is no browser and no
running site for `copilot-web-design-reviewer`, that four of the accessibility lens's five
testing approaches need a rendered page, and that `mattpocock-code-review` has no slash
command to run and no `Agent` tool to fan out with. Where the text depends on the run
rather than the lens, `review/lens-dispatch-extras/<lens>.md` carries it instead and it
travels with the dispatch: `static-analysis` gets the path to this run's tool reports that
way.

### A comment shows the claim and nothing else

No severity, no lens attribution, no count of how many lenses agreed. All three stay in
`findings.json`, and severity still orders the findings, but none of it reaches the
reader.

Severity is withheld because a lens assigns it without the context that decides it. A
missing index is critical on a large table and irrelevant on a small one, and the lens
cannot tell which. Displaying the guess turns the lens's ignorance into the reader's
permission to skip. The same argument rules out filtering by severity: a label too
unreliable to show is far too unreliable to hide findings with.

Agreement between lenses is withheld because it tracks how conspicuous a defect is, not
how much it matters. On a ten-lens run the most-corroborated finding was a cache-key nit
that six lenses spotted, while the missing index, the RSC boundary violation, and the
keyboard-access failure were each found by one. Showing "6 of 10" beside the nit tells
the reader it is the consensus priority, which is the opposite of the truth.

### The orchestrator decides which threads to close

A thread is finished when its defect has left the code or when someone settled it, and
neither is a question a rule answers. `isOutdated: true` means the anchored line changed,
which a fix landing elsewhere does not produce and an unrelated edit above does, so the
orchestrator weighs it against the diff rather than treating it as a condition. It leaves
open any thread a human opened, any whose last comment asks an unanswered question, and
any it is unsure about. Each closure carries a reason, and the review lists them, so a
wrong call is visible rather than an inbox that empties with no reason recorded.

Which threads are the run's own is decided by two things together: the login the review
posts under, and a hidden marker `post-review.ts` writes into every comment.
`github-actions[bot]` is the login of every workflow posting with `github.token`, so the
login alone would put another workflow's threads on the list this run may close.

A resolved thread also settles its finding: `resolved: true` marks it `declined` with no
reading of replies. That makes resolving a thread the way to dismiss a finding for good.
It also takes write access, which commenting does not.

Outside CI the review posts under a person's own account, so `RESOLVE_THREADS=0` renders
`resolve-none.md` in place of `resolve-judge.md` and the orchestrator closes nothing. The
two are separate files rather than one policy followed by its retraction, so that the
prompt states one policy whichever way the run goes.

### `post-review.ts` anchors the findings

Whether a line sits inside a diff hunk is exact, and a wrong answer is expensive: the
review API is atomic, so a single bad anchor makes the API return 422 and create no
comments at all. Lenses also self-report `in_diff` incorrectly, so `post-review.ts`
checks the value against the diff. Findings it cannot anchor go in the review body. If
GitHub rejects the batch, `post-review.ts` posts the review body alone.

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

A run in which nothing survives still posts. Zero findings and a failed lens is the shape
of a review that never happened, and posting nothing leaves a pull request looking clean.

### MCP servers are disabled

`--strict-mcp-config` with no config file disables them. They added roughly 28k tokens
per session, and a diff review uses nothing they provide.

### A lens agent ships pre-built

What changes between runs is the base ref and the pathspec, and both reach a lens
through the message the orchestrator sends: the ref as text, the pathspec as the path to
a generated `diff.sh`. What does not change (which skill to load, the output schema,
report-do-not-repair) is the agent's own system prompt, so `agents/` is rendered once by
`scripts/build-lens-agents.ts` and checked in. That split lets a session run the same
lenses the action does: Claude Code loads a plugin's agents when the session starts, and
nothing can add more halfway through.

A lens the plugin does not bundle has no agent to check in, so `build-prompts.sh` renders
one into the run's plugin with the same script. It used to dispatch the generic agent and
tell the orchestrator which skill to pass on, and a lens that never received that line
returned a competent general review under its name with no skill loaded.

### The action assembles its plugin in `RUNNER_TEMP`

It copies in only the lenses named for that run, so an unrequested lens has no agent to
dispatch and no skill to load, which is a second lock on the `lenses` input besides the
list in the prompt. Building it outside the workspace also leaves the calling
repository's tree untouched. A session skips all of this: it has the plugin installed
already.

### A static analysis tool reports to a lens

A tool finding is evidence that a pattern matched, and whether anything is wrong here is
a separate question; the `static-analysis` lens's own prompt has the argument. So
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
produce one comment with three names in `found_by` rather than three comments. A tool
that did not run is a lens that says so, which `lens_health` already knows how to
report.

That lens is told to keep anything it cannot rule out, for the same reason the
orchestrator marks an uncertain finding `new`: a wrong keep costs a reader seconds, and
a wrong drop is a finding that will be raised and discarded on every run without anybody
seeing it. It reports how many it dropped, and the raw tool report stays in the run
artifact, so its judgement can be checked rather than trusted.

Each report caps what it hands the lens, and it caps the low end: semgrep's findings are
sorted `ERROR` first and osv-scanner's by CVSS score before either is cut. A cap in
emission order would drop a hundred `INFO` hits' worth of real ones. Both report how many
went, and everything raised stays in `build/tool-*.json`.

### The orchestrator runs in its own process

A review reads two things written by whoever opened the pull request: the diff, and
every comment on it. A Claude Code session holds an editor, a shell, and whatever MCP
servers its owner has connected: mail, payments, error tracking. Untrusted text and that
set of tools in one context is the whole of prompt injection, so `run.sh` spends a
second process keeping them apart. The session reads `findings.json` back and nothing
else.

### Which permissions a lens gets is an argument

CI passes `bypassPermissions`: the runner is disposable, and a classifier that refused a
lens halfway would narrow a review that cost $36 to produce. `/codeferret:review` passes
`auto`. Under `auto`, a lens can run `git diff`, `git log` and `rg`, and the classifier
refuses the rest; that was measured on a real dispatch rather than assumed. Either way
`permission_denials` is counted out of the run log and reported, so a mode that starts
refusing commands a lens needs shows up as a number rather than as a thinner review.

### A bundled lens's `description` is rewritten

Upstream wrote each one to win an invocation, and `writing-review`'s reads "proactively
whenever writing, reviewing, or rewriting text". That is right for a skill somebody
installed deliberately and wrong for fourteen that arrived inside a code review tool.
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

   Add `contents: write` as well to let CodeFerret resolve finished threads.
   `resolveReviewThread` is gated on repository write access, which `pull-requests: write`
   does not give. Weigh it: the review agent runs with `bypassPermissions` and Bash, so a
   token that can write contents is a token that can push. Without it everything else
   works and the review says which threads it would have closed.

2. Set `CLAUDE_CODE_OAUTH_TOKEN` as a repository secret. Create the token with
   `claude setup-token`.

No checkout step is needed. The action checks out the pull request head with full history,
but only when the workspace has none, so it never cleans away work an earlier step
produced. Check out yourself and set `checkout: skip` if you need submodules, LFS, or a
sparse checkout.

The action also installs `bun` and `claude` when they are not already on PATH. Set
`install: skip` to provide them yourself, which is also how you pin their versions
rather than letting a job that holds your OAuth token install the latest.

Use `command-prefix` when the repository runs its toolchain in a container. For example,
`docker compose exec -T -w /app devtools`. The prefix must put both binaries on PATH,
mount the checkout, and start in the repository root, because the review reads the
working tree and runs `git diff`.

Actions provides `GITHUB_TOKEN`, so `github-token` only needs setting to override it. Set
`own-login` with it: a run tells its own review threads from a person's by the login they
were posted under, and a token that is not the default posts under a different one.
