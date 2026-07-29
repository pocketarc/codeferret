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

A run is one CI job, one orchestrator session, and N lens subagents. The orchestrator
merges the findings. `post-review.ts` checks which findings GitHub can anchor, then
posts the review.

## Adding a lens

A lens name resolves in one of two places, so you can add a lens to the action or to a
single repository.

To add a lens for every repository that uses the action, put the skill under
`lenses/skills/<name>/` here. It loads namespaced as `codeferret:<name>`.

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
one. A review job holds a `pull-requests: write` token, so you should be able to review
the code it runs, and that code should not change between runs.

## Files

| File | Role |
|---|---|
| `../action.yml` | The composite action: its inputs, and the three steps of a run. |
| `../lenses/` | The bundled skills, packaged as a Claude Code plugin. |
| `lens-brief.md` | The per-lens prompt template. `__SKILL__`, `__BASE__`, and `__SCHEMA__` are substituted. |
| `lens-schema.json` | The shape each lens returns. Prompted but not enforced, because subagents do not inherit `--json-schema`. |
| `orchestrator.md` | The orchestrator's prompt template. |
| `merged-schema.json` | The shape the orchestrator returns. Enforced, because a script parses it. |
| `build-prompts.sh` | Assembles the run's plugin and the orchestrator prompt. |
| `extract-findings.ts` | Reads the merged findings out of the run log. |
| `post-review.ts` | Anchors the findings against the diff, then posts the review. |

## Why it is built this way

Each decision below came from a failed run.

**Every lens must put its findings in the structured output, whatever presentation its
own skill defines.** If a skill defines its own output format, the subagent follows that
format instead, produces prose, and then has nothing left for the schema. One skill did
this, and its lens returned zero findings after a complete, correct review. The analysis
existed and was discarded. Without that instruction, the failure is silent and looks
like a clean pass.

**The brief states the base ref.** For some skills, the subagent asks the user which
commit to diff against. Nothing can answer in a headless run, so the subagent stalls.

**Lenses are prompted with their schema. Only the orchestrator's output is enforced.**
Subagents do not inherit `--json-schema`. That is fine, because a model reads their
output and handles drift. A script parses the orchestrator's output, so that output is
validated.

**The orchestrator merges the findings.** Two lenses routinely report the same defect at
different lines, one at the line where tainted input arrives, one at the line where the
damage happens. If you deduplicate by file and line, you miss those. If you widen the
tolerance, you merge genuinely separate findings. Whether two findings are the same
defect is a question about meaning, so a model answers it.

**`post-review.ts` anchors the findings.** Whether a line sits inside a diff hunk is
exact, and a wrong answer is expensive: the review API is atomic, so a single bad anchor
makes the API return 422 and create no comments at all. Lenses also self-report
`in_diff` incorrectly, so `post-review.ts` checks the value against the diff. Findings
it cannot anchor go in the review body. If GitHub rejects the batch, `post-review.ts`
posts the review body alone.

**The orchestrator reports `lens_health` for every lens it dispatched, including the
ones that found nothing.** A lens that spends money and returns nothing exits
successfully and looks identical to a clean run. That is survivable at three lenses and
invisible at twenty.

**MCP servers are disabled.** `--strict-mcp-config` with no config file disables them.
They added roughly 28k tokens per session, and a diff review uses nothing they provide.

**The run's plugin is assembled in `RUNNER_TEMP`, not in the repository under review.**
Each lens subagent needs the base ref in its prompt, so agent definitions are per-run
and cannot ship pre-built. Building them outside the workspace also leaves the calling
repository's tree untouched.

## Using the action in another repository

1. Add a workflow that grants `pull-requests: write`. A composite action cannot grant
   itself permissions, so the calling workflow must declare it. Without it, the posting
   step fails with 403.
2. Check out with `fetch-depth: 0`. Every lens diffs against the base branch, and a
   shallow clone has no merge-base.
3. Set `CLAUDE_CODE_OAUTH_TOKEN` as a repository secret. Create the token with
   `claude setup-token`.
4. Make `claude` and `bun` available. Install them on the runner, or set
   `command-prefix` to run them in a container.

Use `command-prefix` when the repository runs its toolchain in a container. For example,
`docker compose exec -T -w /app devtools`. The prefix must put both binaries on PATH,
mount the checkout, and start in the repository root, because the review reads the
working tree and runs `git diff`.

Actions provides `GITHUB_TOKEN`, so `github-token` only needs setting to override it.
