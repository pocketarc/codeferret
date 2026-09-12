# shellcheck shell=bash
# The toolchain a review runs on. Sourced, never run.
#
# Pinned, because the install step puts these binaries into a job holding
# CLAUDE_CODE_OAUTH_TOKEN and a token that can write to pull requests, and `npm install -g`
# with no version takes whatever the registry serves that minute. Everything else a run
# executes is pinned the same way: actions by commit, tool images by digest, vendored lenses
# by upstream commit. Bump these with those.
#
# One file because .github/workflows/lint.yml installs bun too, and it does so to run a
# fork's tests, so it has the same reason to pin. A version in two files with a comment asking
# for one edit is a version that drifts, and the drift is quiet: the tests pass under one bun
# and the review runs under another.
#
# Exported rather than plain, so that shellcheck can tell an assignment read elsewhere from
# one nothing reads.
#
# Bumping CLAUDE_CODE_VERSION obliges a re-measurement nothing here asks for: several claims
# about how the CLI isolates a session, and about what it hands a dispatched lens, were each
# established on one build, and moving this line puts them a version behind with nothing
# failing. "The measurements behind the session boundary were taken on a build the run no longer
# installs" in CLAUDE.md's accepted risks has which claims those are and what retaking them
# needs.
export BUN_VERSION=1.3.14
export CLAUDE_CODE_VERSION=2.1.224
