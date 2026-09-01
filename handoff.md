# Handoff: `feat/claude-code-plugin`

## What CodeFerret is

A code review tool. It reads a diff through several independent review skills ("lenses") at
once and merges their findings into one review comment. It runs two ways: as a GitHub
composite action on a pull request, or as a Claude Code plugin (`/codeferret:review`) on the
branch in front of you. Both paths call the same `review/run.sh`, so a change to how a review
works lands in both at once.

## What this branch does

Adds the plugin side. Before this branch, CodeFerret only ran as the GitHub action. This adds
`.claude-plugin/`, `commands/`, and the plugin-facing scripts (`local-run.sh`,
`local-post.sh`, `local-print.sh`, `local-preflight.sh`), and reworks the shared pipeline
(`review/`) so both front doors go through it. It's PR
[#3](https://github.com/pocketarc/codeferret/pull/3), open against `main`.

## Where things stand

At the head of `feat/claude-code-plugin`, 414 tests and all four gates green:

```sh
bun install                          # once; wires up lefthook
bun scripts/validate-repo.ts
bun run typecheck
shellcheck -e SC2016 review/*.sh scripts/*.sh
bun test
```

Read `CLAUDE.md` first for anything not covered here: branch rules, what never to touch,
what's accepted as a known risk and why. `review/README.md` has how a run works.
`review/DECISIONS.md` has why each part is built the way it is.

## What's left

- Close [#2](https://github.com/pocketarc/codeferret/pull/2),
  `fix/do-not-persist-credentials`. Close rather than rebase: nothing in it is worth
  carrying over. Its `action.yml` half put `persist-credentials: false` on this action's
  own checkout, and a flag applies only to the checkout it sits on, so it missed a caller
  who checks out for themselves. This branch covers both shapes with a "Take the token back
  out of the checkout" step, which unsets whatever is in the workspace config after the last
  fetch, whoever cloned it. Its README half is a rewrite from before several of the things
  it documents changed: `mattpocock-code-review` in the lens table, inline comments, the
  old reading of `contents: write`, and `@v1.0.0`.
- The `PERMISSION_MODE=auto` measurement. `CLAUDE.md`'s accepted-risk entry for the
  orchestrator running under `bypassPermissions` has a lapse condition: run a full review under
  `PERMISSION_MODE=auto` and read `build/permission-denials`. Zero denials means CI can move to
  `auto`, closing a risk that gets raised as a high on most reviews. Nobody has gotten a clean
  read yet: two attempts today both got cut off by the Claude account's session limit,
  including one that ran concurrently with a CI review (don't do that; they share the account).
  Command:
  ```sh
  RT=$(mktemp -d)
  LENSES="$(cat review/defaults/lenses.txt)" \
    EXCLUDE_PATHS="$(cat review/defaults/exclude-paths.txt)" \
    PERMISSION_MODE=auto \
    bash review/run.sh main "$PWD" "$RT/codeferret" "$PWD"
  cat "$RT/codeferret/build/permission-denials"
  ```
  Roughly $45–55, 17–20 minutes. Run it on its own, not alongside a CI review.
- Rebase `test/fixture` and `test/fixture-defects` onto `main`. Needs Bruno's confirmation
  before any force-push, per `CLAUDE.md`. Left until after the branch merges, to avoid
  rebasing repeatedly onto a moving target. `main` hasn't moved since this branch started, so
  it may be a no-op: check before assuming it's needed.
- Turn `comment-review` and `writing-review` back on in
  `.github/workflows/codeferret.yml`'s `exclude-lenses:`. They're off because this branch
  rewrites too much prose per round for CI to be a useful place to catch it; `CLAUDE.md` says
  to run them by hand before a push instead. Take the exclusion out once the branch is small
  and quiet.

## Gotchas worth knowing before you hit them

- `gh run download` fails in this environment with a TLS handshake timeout, every time. Go
  around it:
  ```sh
  ID=$(gh api "repos/pocketarc/codeferret/actions/runs/$RUN/artifacts" \
    --jq '[.artifacts[] | select(.name=="codeferret-run")] | sort_by(.created_at) | last | .id')
  curl -sSL -H "Authorization: Bearer $(gh auth token)" \
    -o a.zip "https://api.github.com/repos/pocketarc/codeferret/actions/artifacts/$ID/zip"
  unzip -oq a.zip -d <dest> && rm a.zip
  ```
  Note `sort_by(.created_at) | last`: re-running a failed job leaves two artifacts under one
  run id, and picking the wrong one gets you stale findings.
- `arc monitor-pr` needs `run_in_background: true`. A review takes 15–20 minutes; the
  foreground tool times out at 2.
