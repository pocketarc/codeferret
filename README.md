# CodeFerret

Many lenses. One review.

CodeFerret reviews a pull request through several independent code review skills at
once, then merges their findings into a single review with inline comments. Each
finding records which lenses found it, so agreement between them is visible rather
than collapsed.

There are two ways to run it: as a GitHub action on every pull request, or as a Claude
Code plugin on the branch in front of you.

## On a pull request

```yaml
permissions:
    contents: write # resolveReviewThread needs it; contents: read disables thread resolution
    pull-requests: write

steps:
    - uses: pocketarc/codeferret@v1
      with:
          claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

That is the whole setup. The action checks the repository out and installs what it needs.

`@v1` moves with each 1.x release. Pin a full version, `@v1.0.0`, to hold a revision.

## On the branch you are working on

```
/plugin marketplace add pocketarc/codeferret
/plugin install codeferret@pocketarc
```

Then, in any repository:

```
/codeferret:review
```

It works out what to diff against (the base of your open pull request, or the default
branch), dispatches the lenses, and prints what they found as `path:line` you can click.
Uncommitted work counts if you want it to. When the branch has a pull request and the
work is pushed, it posts the review; otherwise the findings stay in the terminal.

`/codeferret:install-workflow` writes the action's workflow into the repository you are
in, for when you would rather have this run on every pull request.

Twelve lenses take around 15 minutes and cost several dollars on Opus, so it says what it
is about to do before it does it.

## Where things are

See [`review/README.md`](review/README.md) for the inputs, how to add a lens, and why
each part is built the way it is.

```
action.yml       the composite action
commands/        the slash commands the plugin adds
agents/          one agent per lens, generated from review/lens-brief.md
lenses/skills/   the bundled review skills
review/          prompts, schemas, and the scripts a run uses
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
