---
description: Add the workflow that runs CodeFerret on every pull request.
---

Set this repository up to run CodeFerret on every pull request. `<plugin>` below is
`${CLAUDE_PLUGIN_ROOT}`.

## 1. Check that the workflow has somewhere to go

Stop and say so if this is not a git repository, or if it has no GitHub remote. The
workflow only means anything on GitHub.

If `.github/workflows/codeferret.yml` already exists, do not touch it. Show the
difference against `<plugin>/templates/workflow.yml` and let the user decide what to
take from it.

## 2. Show the workflow, then write it

Read `<plugin>/templates/workflow.yml` and show it before writing anything. It grants
`pull-requests: write` and `contents: read`, and the user should see that first.

`contents: read` is what the template ships, and everything works under it. The one thing
`contents: write` adds is closing the inline threads CodeFerret left on this repository
before `v1.1.0`: a review is one body now and opens no thread of its own, so
`contents: write` is worth granting only while an open pull request still carries one of
those threads. Offer that rather than assuming it, and say what it costs: the review agent
runs with Bash, so a token that can write contents is a token that can push. Taking it
means setting `resolve-threads: 'true'` in the same edit.

The template grants a second permission the user should know about rather than decide on:
`actions: read`. Say what it buys. A run reads the previous run's `findings.json` out of
the `codeferret-run` artifact to know what has already been said; without it every finding
is posted again on every push. It grants read access to the repository's workflow runs and
their artifacts, and nothing more.

Say what the action keeps. Its last step uploads `findings.json` as an artifact and keeps
it for 14 days, which is how long the read above has anything to find. That file holds
every finding: the ones the review suppressed, and the ones it did not print in full.
Whoever can read the repository's artifacts can read those.

The template references `pocketarc/codeferret@v1`, which is not a pin. It is a tag this
repository moves to each new release, so the workflow follows those releases without being
edited. Say so, and say that `@v1.1.0` or a commit SHA holds a revision instead. Say too
that this plugin follows the default branch, so what runs in CI can be a release behind
what runs in this session.

Once the user has agreed, write the template to `.github/workflows/codeferret.yml`.

## 3. Say what is still missing

The workflow does nothing without a token. Check whether the secret is already there:

```sh
gh secret list
```

If `CLAUDE_CODE_OAUTH_TOKEN` is not in that list, tell the user to run these two commands
in their own terminal:

```sh
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN
```

Do not run them yourself, and do not accept the token in chat. `gh secret set` with no
value reads from a terminal you do not have, and the way out of that is to ask for the
token and pass it as an argument, which puts a long-lived credential into this
conversation, into the transcript on disk, and into a process's argument list. Run
`gh secret list` again afterwards to confirm the secret arrived. That is your part of it.

Last, warn about the push. A `gh`-authenticated user whose token lacks the `workflow`
scope can commit a workflow file but cannot push it: GitHub rejects the push with an
error that does not mention scopes. `gh auth refresh -h github.com -s workflow` adds the
scope.
