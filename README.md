# CodeFerret

Many lenses. One review.

CodeFerret reviews a pull request through several independent code review skills at once,
merges what they find into a single review, and posts it with inline comments. Later runs
post only what is new, and close the threads whose findings are finished.

## Quick start

```yaml
name: CodeFerret

on:
    pull_request:
        types: [opened, synchronize, ready_for_review, reopened]

jobs:
    review:
        runs-on: ubuntu-latest
        timeout-minutes: 120
        permissions:
            contents: write
            pull-requests: write
        steps:
            - uses: pocketarc/codeferret@v1
              with:
                  claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

That is the whole setup. The action checks the repository out and installs what it needs.

Create the token with `claude setup-token` and store it as a repository secret.

## Permissions

| Permission | Needed for |
|---|---|
| `pull-requests: write` | Posting the review and its inline comments. |
| `contents: write` | Resolving finished threads. `resolveReviewThread` is gated on repository write access. |

A composite action cannot grant its own permissions, so the calling workflow declares
both. With `contents: read`, everything else runs and the review lists the threads it
would have closed.

## Inputs

| Input | Default | Description |
|---|---|---|
| `claude-code-oauth-token` | *required* | Token from `claude setup-token`. |
| `lenses` | 12 bundled lenses | Newline-separated lens names, one per line. |
| `exclude-paths` | lockfiles, `node_modules`, build output, minified files | Newline-separated globs kept out of the diff every lens sees. Empty string reviews everything. |
| `model` | `opus` | Model for the orchestrator and every lens. |
| `command-prefix` | *(empty)* | Prefix for the `claude` and `bun` calls, for a toolchain that lives in a container. |
| `checkout` | `auto` | `auto` checks out the head with full history when the workspace has none. `skip` never checks out. |
| `install` | `auto` | `auto` installs `bun` and `claude` when they are absent. `skip` assumes both are present. |
| `post` | `true` | `false` runs the review and skips posting it. |
| `base-ref` | PR base branch | Ref to diff against. |
| `pr-number` | triggering PR | Pull request to review. |
| `head-sha` | PR head | Commit to anchor comments against. |
| `github-token` | `${{ github.token }}` | Token used to post and resolve. |

### Outputs

| Output | Description |
|---|---|
| `findings-file` | Path to the merged findings JSON, including suppressed and declined ones. |
| `findings-count` | Number of merged findings. |

### Using a container toolchain

Set `command-prefix` when `bun` and `claude` live in a container rather than on the
runner. The prefix must put both on PATH, mount the checkout, and start in the repository
root, because the review reads the working tree and runs `git diff`.

```yaml
with:
    command-prefix: docker compose exec -T -w /app devtools
```

`install` is ignored when a prefix is set, since the prefix owns its toolchain.

## Lenses

Twelve ship with the action:

| Lens | Source |
|---|---|
| `caveman-review` | JuliusBrussee/caveman |
| `mattpocock-code-review` | mattpocock/skills |
| `anthropic-code-review` | anthropics/knowledge-work-plugins |
| `anthropic-accessibility-review` | anthropics/knowledge-work-plugins |
| `wshobson-code-review-excellence` | wshobson/agents |
| `sentry-security-review` | getsentry/skills |
| `copilot-security-review` | github/awesome-copilot |
| `copilot-sql-code-review` | github/awesome-copilot |
| `copilot-web-design-reviewer` | github/awesome-copilot |
| `vercel-next-best-practices` | vercel-labs/openreview |
| `comment-review` | first-party |
| `writing-review` | first-party |

Name a subset to run fewer:

```yaml
with:
    lenses: |
        caveman-review
        sentry-security-review
```

To add one of your own, put a skill at `.claude/skills/<name>/SKILL.md` in your
repository and name it alongside the rest. The action resolves a lens name against its
own bundled skills first, then yours.

Every run reports what each lens found, and flags any that could not do its job, so a
lens returning nothing is visible rather than silently absent.

## REVIEW.md

A `REVIEW.md` at the repository root goes to the standards lens: the conventions a
reviewer cannot work out from a diff. Per-directory sections work well.

```markdown
## apps/backend

Call `JSON.stringify` on a value before writing it to a JSON column; the driver does not
serialise objects for JSON columns.
```

Only that lens receives it. A rulebook handed to every lens pulls them all toward the
same generalist reading, and the findings worth having come from lenses staying inside
their own domain.

## Later runs

Each run reads the whole discussion on the pull request. A finding already commented on,
or answered with a reply that settles it, or sitting on a resolved thread, is not posted
again. Everything hidden is counted in the review, and `findings-file` holds all of it
with each finding's status.

Resolving a thread yourself is the way to dismiss a finding for good.

## Versions

`@v1` moves with each 1.x release. Pin `@v1.0.0` to hold a revision.

## Limits

- A review needs a `pull_request` event, or `pr-number`, `head-sha` and `base-ref` given
  together.
- Comments guide what gets posted again, and every comment counts. On a public repository
  anyone can comment, and nothing stops a stranger's comment from being read that way.
- Twelve lenses on a small diff take around 17 minutes.

## Testing it against itself

`main` holds only the tool. The test fixture lives on two branches that are never merged:
`test/fixture`, a clean PHP and TypeScript application with the standards and issue spec
a review is scored against, and `test/fixture-defects`, which adds a change mixing real
defects with plausible-looking non-defects.

The scoring key is deliberately **not** in this repository. A reviewer that can read the
answers is not being measured.

[`review/README.md`](review/README.md) covers how a run works and why each part is built
the way it is.
