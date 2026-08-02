# CodeFerret

Like CodeRabbit, but it uses your Claude subscription, and goes even deeper.

CodeFerret reviews a diff through fourteen independent code review skills at once, then
merges their findings into a single review comment. Each finding records which of the
fourteen found it, so agreement between them stays visible.

There are two ways to run it: as a GitHub action on every pull request, or as a Claude
Code plugin on the branch in front of you.

## On a pull request

[`templates/workflow.yml`](templates/workflow.yml) is the workflow to copy, and
`/codeferret:install-workflow` writes it into a repository for you. What it comes down
to:

```yaml
permissions:
    contents: read # write instead to let it resolve finished threads
    pull-requests: write
    actions: read # so a finding is not raised again on every push

steps:
    - uses: pocketarc/codeferret@v1
      with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          resolve-threads: 'false' # 'true' with contents: write
```

That is the whole job. The action keeps its own `codeferret-run` artifact holding
`findings.json`, so there is no upload step to write and no name to get right. The comment
carries the critical and high findings in full and points at that file for the rest: every
medium, low and nit finding. That file is also what the next run reads to know what was
said before.

`contents: write` costs something. The review runs an agent with Bash, so a token that
can write contents is a token that can push. On `read`, everything else works and nothing
tries to close a thread.

`actions: read` costs little and the review is worse without it. It is used for one thing:
reading the previous run's `findings.json` back out of the artifact. Drop it and a run
cannot see what the last one said, every finding counts as new, and the review repeats
itself on every push.

The rest of that file is:

- A concurrency group, so three pushes in a row do not buy three full reviews.
- A gate on drafts, so a push to unfinished work costs nothing. The review runs when the
  author marks the pull request ready.
- A gate on forks, which cannot read the secret.
- A gate on author association, limiting who can spend the budget to an owner, a member
  or a collaborator.
- A 60-minute timeout.

The action's own artifact is kept for 14 days, and whoever can read the repository's
artifacts can read every finding in `findings.json`, the suppressed ones included.

The action checks the repository out and installs what it needs. It also runs semgrep and
osv-scanner before the review, from the runner's binaries if they are there and from
pinned containers otherwise, which means a container pull on the first run and a lookup
against osv.dev for each changed lockfile. Set `tools: ''` to run neither.

`@v1` moves with each 1.x release. Pin a full version, `@v1.1.0`, to hold a revision.

## On the branch you are working on

```
/plugin marketplace add pocketarc/codeferret
/plugin install codeferret@pocketarc
```

It needs `bash` and `bun`, which on Windows means WSL or Git Bash. Without `gh` the
review still runs and prints, but it cannot read what has already been said on a pull
request and it cannot post.

The plugin follows this repository's default branch rather than a tag, so `/plugin update`
gives you whatever last landed on `main`. The action's `@v1` moves only on a release, so
the two can be a release apart.

Then, in any repository:

```
/codeferret:review
```

The command works out what to diff against (the base of your open pull request, or the
default branch), dispatches the lenses, and prints what they found as `path:line` you can
click. Ask, and it includes uncommitted work. It offers to post the review when three
things hold: the branch has an open pull request, your commits are pushed, and your
working tree is clean. Otherwise the findings stay in the terminal. Every line in a review
belongs to the commit the lenses read, and a file you have edited since is a file whose
lines have moved.

Posting uses your `gh` credential, which is usually scoped to everything you can reach.
Export a fine-grained token as `GITHUB_TOKEN` if you would rather it were not: `gh` takes
that in preference to its own.

`/codeferret:install-workflow` writes the action's workflow into the repository you are
in, for when you would rather have this run on every pull request.

Lenses run in parallel, so fourteen of them take about as long as three and cost a good
deal more. One fourteen-lens run came to $36.00 and 20m46s on Opus, and returned 97
findings. `/codeferret:review` says how many lenses it is about to dispatch, and waits;
the action reports what each run cost in the job summary.

## Where things are

See [`review/README.md`](review/README.md) for the inputs, how to add a lens, and why
each part is built the way it is.

```
action.yml       the composite action
.claude-plugin/  the plugin and marketplace manifests
commands/        the slash commands the plugin adds
agents/          one agent per lens, generated from review/lens-brief.md
lenses/skills/   the bundled review skills
review/          prompts, schemas, and the scripts a run uses
templates/       the workflow /codeferret:install-workflow writes
```

## Testing it against itself

`main` holds only the tool. The test fixture lives on two branches that are never
merged:

| Branch | Contents |
|---|---|
| `test/fixture` | A clean Laravel-style PHP backend and Next-style TypeScript frontend, plus the coding standards and issue spec a review is scored against. |
| `test/fixture-defects` | Branched from `test/fixture`, adding a change that deliberately mixes real defects with plausible-looking non-defects. |

Two pull requests exercise different things:

- `test/fixture-defects` against `test/fixture` is the realistic case. Its diff touches
  7 files, and some findings root-cause into files the diff does not touch, which is what
  measures whether a lens follows a defect out of the changed lines.
- `test/fixture-defects` against `main` puts the whole fixture in one diff, so every
  lens reads every file.

The fixture mirrors PHP and TypeScript so that language-specific review guidance gets
exercised on both sides.

The scoring key is deliberately **not** in this repository. A reviewer that can read
the answers is not being measured.
