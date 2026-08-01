---
description: Add the workflow that runs CodeFerret on every pull request.
---

Set this repository up to run CodeFerret on every pull request. `<plugin>` below is
`${CLAUDE_PLUGIN_ROOT}`.

## 1. Check there is somewhere to put it

Stop and say so if this is not a git repository, or if it has no GitHub remote — the
workflow only means anything on GitHub.

If `.github/workflows/codeferret.yml` already exists, do not touch it. Show the
difference against `<plugin>/templates/workflow.yml` and let the user decide what to
take from it.

## 2. Show the workflow, then write it

Read `<plugin>/templates/workflow.yml` and show it before writing anything. It grants
`pull-requests: write` and `contents: read`, and the user should see that first.

`contents: read` is what the template ships, and everything works under it except closing
a finished thread — the review lists the ones it would have closed instead. Offer the
upgrade to `contents: write` rather than assuming it, and say what it costs: the review
agent runs with Bash, so a token that can write contents is a token that can push.

The template pins `pocketarc/codeferret@v1`, which is the last tagged release. This
plugin follows the default branch instead, so what runs in CI can be a release behind
what runs in this session. Say so.

Once the user has agreed, write the template to `.github/workflows/codeferret.yml`.

## 3. Say what is still missing

The workflow does nothing without a token. Check whether the secret is already there:

```sh
gh secret list
```

If `CLAUDE_CODE_OAUTH_TOKEN` is not in that list, walk the user through creating one:

```sh
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

Last, warn about the push. A `gh`-authenticated user whose token lacks the `workflow`
scope can commit a workflow file but cannot push it: GitHub rejects the push with an
error that does not mention scopes. `gh auth refresh -h github.com -s workflow` adds the
scope.
