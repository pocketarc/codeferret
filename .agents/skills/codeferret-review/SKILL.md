---
name: codeferret-review
description: Run local CodeFerret multi-lens reviews through the Codex CLI, inspect checked findings, and post results only on explicit request.
---

# CodeFerret review

Use this skill when the user requests a local CodeFerret review through Codex. The CLI runs locally and sends review input to OpenAI-hosted models through the user's ChatGPT subscription.

## Prepare the review

1. Resolve the CodeFerret root at `../../../` relative to this skill's directory.
2. Check that Codex CLI, Bun, and git are installed. CLI 0.153.4 is the tested version.
3. Run `codex login status`. Continue only with an existing ChatGPT login.
4. Run preflight from the checkout to review:

   ```bash
   bash "/absolute/codeferret/root/review/codex.sh" preflight <<'CODEFERRET_BASE'
   origin/main
   CODEFERRET_BASE
   ```

   Replace the path with the resolved root. Replace `origin/main` with the requested base, or leave that line empty for automatic resolution. Keep the heredoc delimiter quoted. Never interpolate the requested base into shell syntax.

5. Validate preflight paths and refs before the review. Stop for `unsafe` values or absent `repo`, `toplevel`, or `head`. For `plugin=unset:PATH` or `plugin=mismatch:PATH`, check that `PATH` matches the resolved CodeFerret root. Check that `base_resolves=yes` and `merge_base` names a commit. If the base remains unresolved, ask the user for a base.
6. Inspect `dirty` and `untracked` against the requested scope. If the scope is ambiguous, ask the user before the review. For untracked files, obtain authorization before `git add -N` on each selected file.

Use the bundled `review/codex.sh` for every command. A review can run without a pull request.

## Run and inspect

1. Run the requested review from the checkout:

   ```bash
   bash "/absolute/codeferret/root/review/codex.sh" run "VALIDATED_BASE"
   ```

   Append selected lens names as separate arguments. To include uncommitted tracked changes, set `INCLUDE_WORKING_TREE=1`. For this scope, pass the validated `merge_base` commit as the base.

2. Record the exit status. Print checked results after every run, including any nonzero exit status:

   ```bash
   bash "/absolute/codeferret/root/review/codex.sh" print
   ```

3. Report findings, failures, and missing coverage from the saved output. If `print` fails, report its error and inspect the process logs.

Partial session failures return status `1` and can still have checked findings. Do not describe an incomplete review as clean.

CodeFerret uses all default lenses unless the user selects lenses. Up to three lens processes run at once, followed by one merge process.

| Variable | Values |
| --- | --- |
| `CODEX_CONCURRENCY` | Default: `3`. Range: `1` through `16`. |
| `CODEX_TIMEOUT_MS` | Timeout per process in milliseconds. Default: `1800000`. Range: `1` through `43200000`. |
| `MODEL` | Optional model name. If unset, CodeFerret uses the Codex CLI default. CodeFerret ignores `config.toml`. |
| `EFFORT` | Optional: `low`, `medium`, `high`, or `xhigh`. |

Output is under `<git-dir>/codeferret/codex-run/build`. Process logs are under `<git-dir>/codeferret/codex-run/session`. Codex does not supply a dollar price. Report the cost as unknown.

Each process starts outside the repository with a read-only sandbox and `project_doc_max_bytes=0`. CodeFerret ignores `config.toml` and rules, and disables hooks, plugins, apps, memory, and browser tools. Global user `AGENTS.md` instructions and skills remain available to Codex. Use the existing login. Do not copy `auth.json`.

## Post on explicit request

1. Check that the user explicitly authorized posting to the target pull request. If authorization is absent, ask and wait.
2. Run the post command with the validated pull request number:

   ```bash
   bash "/absolute/codeferret/root/review/codex.sh" post PR_NUMBER
   ```

3. Report the command result.

Do not bypass posting checks or modify the CI workflow for a local review.
