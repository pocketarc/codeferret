# CodeFerret

Like CodeRabbit, but it uses your Claude subscription, and goes even deeper.

CodeFerret reviews a diff through several independent code review skills at once, then
merges their findings into a single review with inline comments. Each finding records
which lenses found it, so agreement between them is visible rather than collapsed.

There are two ways to run it: as a GitHub action on every pull request, or as a Claude
Code plugin on the branch in front of you.

## On a pull request

[`templates/workflow.yml`](templates/workflow.yml) is the workflow to copy, and
`/codeferret:install-workflow` writes it into a repository for you. What it comes down
to:

```yaml
permissions:
    contents: read # write instead to let it resolve finished threads, at the cost below
    pull-requests: write

steps:
    - uses: pocketarc/codeferret@v1
      with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

The rest of that file is a concurrency group, so three pushes in a row do not buy three
full reviews; a gate that skips pull requests from forks, which cannot read the secret;
and a 60-minute timeout. The action checks the repository out and installs what it needs.

`@v1` moves with each 1.x release. Pin a full version, `@v1.0.0`, to hold a revision.

## On the branch you are working on

```
/plugin marketplace add pocketarc/codeferret
/plugin install codeferret@pocketarc
```

It needs `bash` and `bun`, which on Windows means WSL or Git Bash. Without `gh` the
review still runs and prints, but it cannot read what has already been said on a pull
request and it cannot post.

Then, in any repository:

```
/codeferret:review
```

It works out what to diff against (the base of your open pull request, or the default
branch), dispatches the lenses, and prints what they found as `path:line` you can click.
It can include uncommitted work if you ask. When the branch has a pull request, the work
is pushed, and nothing is modified locally, it offers to post the review; otherwise the
findings stay in the terminal. A comment is anchored to a line GitHub holds, and a file
you have edited since is a file whose lines have moved.

Posting uses your `gh` credential, which is usually scoped to everything you can reach.
Export a fine-grained token as `GITHUB_TOKEN` if you would rather it were not — `gh` takes
that in preference to its own.

`/codeferret:install-workflow` writes the action's workflow into the repository you are
in, for when you would rather have this run on every pull request.

Lenses run in parallel, so twelve of them take about as long as three and cost a good
deal more. One twelve-lens run over a 47-file diff came to $31.80 and 19 minutes on Opus.
`/codeferret:review` says how many lenses it is about to dispatch, and waits; the action
reports what each run cost in the job summary.

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
  7 files, and some findings root-cause into files the diff does not touch, which is
  what exercises the out-of-diff anchoring path.
- `test/fixture-defects` against `main` puts the whole fixture in one diff, so every
  lens reads every file.

The fixture mirrors PHP and TypeScript so that language-specific review guidance gets
exercised on both sides.

The scoring key is deliberately **not** in this repository. A reviewer that can read
the answers is not being measured.
