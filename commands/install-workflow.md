---
description: Add the CodeFerret workflow to this repository, so every pull request gets reviewed.
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
`pull-requests: write` and `contents: write`, and the user should see that first.

`contents: write` is what lets CodeFerret resolve finished threads, and it is worth a
sentence: the review agent runs with Bash, so a token that can write contents is a token
that can push. Dropping to `contents: read` leaves everything else working, and the
review then lists the threads it would have closed. Offer that.

Write it to `.github/workflows/codeferret.yml` once the user has agreed.

## 3. Say what is still missing

The workflow does nothing without a token. Walk the user through it:

```sh
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

Then check whether the secret is already there, and say which it is:

```sh
gh secret list
```

Last, warn about the push. A `gh`-authenticated user whose token lacks the `workflow`
scope can commit a workflow file and cannot push it, and GitHub rejects it with an error
that does not mention scopes. `gh auth refresh -h github.com -s workflow` adds it.
