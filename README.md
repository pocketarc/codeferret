# CodeFerret

Many lenses. One review.

CodeFerret reviews a pull request through several independent code review skills at
once, then merges their findings into a single review with inline comments. Each
finding records which lenses found it, so agreement between them is visible rather
than collapsed.

```yaml
- uses: pocketarc/codeferret@v1
  with:
      claude-code-oauth-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

See [`review/README.md`](review/README.md) for the inputs, how to add a lens, and why
each part is built the way it is.

```
action.yml   the composite action
lenses/      bundled review skills, packaged as a Claude Code plugin
review/      prompts, schemas, and the scripts a run uses
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
