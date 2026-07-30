# CodeFerret

A GitHub composite action that reviews a pull request through several independent code
review skills ("lenses") at once, then merges their findings into one review with
inline comments.

For why each part is built the way it is, see [`review/README.md`](review/README.md).
This file is about working in the repository.

## Branches

| Branch | Contents | Rule |
|---|---|---|
| `main` | The action and bundled lenses. Nothing else. | Tool changes go here. |
| `test/fixture` | A clean fixture application, plus the coding standards and issue spec a review is scored against. | Never merge. |
| `test/fixture-defects` | Branched from `test/fixture`, adding deliberate defects. | Never merge. |

Both `test/` branches are permanent, disposable fixtures whose only purpose is to be
reviewed.

**Never commit a tool change to a `test/` branch.** The reviewed diff is
`test/fixture...test/fixture-defects`, so anything you add there becomes part of what
the lenses review. This has already happened once: the whole action ended up inside
the diff, and the lenses spent the run's budget reviewing themselves instead of the
fixture.

To get a tool change onto the fixture branches, first commit it to `main`. Then rebase
both:

```sh
git rebase main test/fixture
git rebase test/fixture test/fixture-defects
```

Both branches then need a force-push. Confirm with Bruno first. Then push both with
`--force-with-lease`.

Rebase rather than merge, so each fixture branch stays "main plus one fixture commit"
and the reviewed diff stays exactly the fixture.

## Never fix the seeded defects

`test/fixture-defects` contains SQL injection, an IDOR, a hardcoded credential, path
traversal, `dangerouslySetInnerHTML` on unsanitised input, float arithmetic on money,
and more. They are all deliberate, and they are the measuring instrument. If you fix
them, there is nothing left to score a review against.

`backend/app/Support/Sanitizer.php` on `test/fixture` is a no-op on purpose. It sits
*outside* the reviewed diff, which is what exercises the out-of-diff anchoring path.
Leave it alone.

The scoring key lives outside the repository. Do not add it. A reviewer that can read
the answers cannot be measured.

Fixture values that look like real credentials must not match a real provider's
detectable format. Use an obviously invented prefix. GitHub push protection blocked a
branch once over a fake `sk_live_...` Stripe key.

## Before you push

```sh
bun scripts/validate-manifests.ts
```

GitHub validates workflow syntax when you push, but it does not validate an action
manifest until a run loads it. So nothing catches a broken `action.yml` until the first
step of a real review fails. That is how an unquoted `pull-requests: write` inside an
input description shipped once. Quote any string that contains `: `.

## Running a review locally

Run this from a checkout of the branch you want reviewed. The full sequence, without
GitHub:

```sh
RT=$(mktemp -d)
printf 'caveman-review\nsentry-security-review\n' \
  | bash review/build-prompts.sh test/fixture "$PWD" "$RT/codeferret" "$PWD"

claude -p "$(cat "$RT/codeferret/build/orchestrator.txt")" \
  --model opus --output-format json \
  --json-schema "$(cat review/merged-schema.json)" \
  --permission-mode bypassPermissions --strict-mcp-config \
  --no-session-persistence --plugin-dir "$RT/codeferret" \
  > "$RT/codeferret/build/run.json"

bun review/extract-findings.ts \
  "$RT/codeferret/build/run.json" "$RT/codeferret/build/findings.json"
```

Print the review without posting it:

```sh
DRY_RUN=1 GITHUB_TOKEN=x GITHUB_REPOSITORY=pocketarc/codeferret \
  bun review/post-review.ts "$RT/codeferret/build/findings.json" \
  test/fixture test/fixture-defects 1
```

Budget roughly 15 minutes and several dollars per run on Opus with three lenses.

## Adding a lens

To bundle a skill with the action, put it under `lenses/skills/<name>/`. To use it in
one repository only, put it under the consuming repository's own
`.claude/skills/<name>/`. Then name the lens in the action's `lenses` input. If a named
lens has no `SKILL.md` in either place, `build-prompts.sh` fails.

Vendor bundled skills at a pinned upstream commit and record the commit in
`lenses/skills/PROVENANCE.tsv`. Never fetch a skill at run time: a review job holds a
`pull-requests: write` token, so everything it executes should be reviewable and should
not change between runs.

## Things that will bite you

- **A lens's `in_diff` field is unreliable.** On every run so far, a lens reported an
  out-of-diff finding as in-diff. `post-review.ts` checks each line against the diff
  hunks instead of the lens's claim. Do not remove that check: the review API is atomic,
  so a single bad anchor fails the whole request with 422 and no comments are posted.
- **Do not ask the orchestrator for counts.** It narrated "27 by three lenses" when the
  answer was 31. `post-review.ts` computes totals, quorum, and severity spread.
- **A lens that returns zero findings is probably broken.** One spent $1.28, exited 0,
  and emitted nothing after a complete and correct review, because its skill prescribed
  a prose format and the schema has no field for prose. That is why every finding must
  go through the structured output (see `review/lens-brief.md`), and why the posted
  review includes `lens_health`.
- **The lens brief must state the base ref.** Without it, some lenses stop and ask which
  commit to diff against, and nothing can answer in a headless run.
- **Subagents do not inherit `--json-schema`.** Their schema comes from the prompt, so
  do not trust the shape of lens output. Only the orchestrator's output is validated.
