# shellcheck shell=bash
# What more than one of this repository's shell scripts needs. Sourced, never run.

# ---- GitHub Actions step outputs ----------------------------------------------------

# One GitHub Actions step output, for action.yml's `run:` steps.
#
# The heredoc form for every value, one-line ones included. In the `name=value` form GitHub
# reads a value's second line onward as further outputs, and `base-ref`, `pr-number` and
# `head-sha` all arrive from a workflow input: a `base-ref` whose second line reads
# `head=<sha>` would otherwise set the commit the review is recorded against.
#
# The delimiter is drawn fresh for each value, because a fixed one is the same hole one step
# in: a value carrying that exact line closes the heredoc early, and everything after it is
# read as further outputs again.
emit_output() {
    local delim
    delim="CF_$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

    {
        printf '%s<<%s\n' "$1" "$delim"
        printf '%s\n' "$2"
        printf '%s\n' "$delim"
    } >>"$GITHUB_OUTPUT"
}

# The same for a value in a file, and nothing at all when the file is not there.
#
# `$(cat)` rather than the file itself: extract-findings.ts writes these with no trailing
# newline, which would run the value into the delimiter.
emit_output_file() {
    if [ ! -f "$2" ]; then
        return 0
    fi

    emit_output "$1" "$(cat "$2")"
}

# ---- The one name the scripts have to agree on --------------------------------------

# The lens the static analysis tools report to, and the only one that reads their reports.
# Declared once, because more than one script decides what to run by matching this name
# against a lens list, and validate-repo.ts checks the action's defaults against it.
export TOOLS_LENS=static-analysis

# ---- The empty form of the file the orchestrator is handed ---------------------------

# What existing.json says when there was no pull request to fetch it from, or when the fetch
# failed before it could write.
#
# Written once here rather than spelled out at each of the places a run needs it. The keys
# are the ones STEP 3 of the orchestrator prompt names, and `asExisting` reads a missing
# `threads` as an empty list, so a copy that drifts hands the vetting a file with a key it
# does not recognise, and every suppression is reopened with nothing saying why.
empty_existing() {
    printf '{"threads": [], "conversation": []}\n' >"$1"
}

# ---- Where a run keeps its files ----------------------------------------------------

# The run directory and the build directory inside it, as RUN_DIR and BUILD_DIR.
#
# `build/` is the one name every part of a run has to agree on. Rename it here and leave it
# spelled out by hand somewhere else, and a review runs, costs the money, and posts against a
# diff nothing read. The pathspec was built twice once and drifted, which is why
# review/diff-args.ts exists; this is the same fact one level up.
#
# The root is the caller's: `runner_run_dir` on a runner, `session_run_dir` on somebody's
# own machine.
run_dirs() {
    RUN_DIR="$1"
    BUILD_DIR="$1/build"
    export RUN_DIR BUILD_DIR
}

# Where the action puts a run. Under RUNNER_TEMP, which the runner clears between jobs, and
# which `command-prefix` is asked to mount at the same absolute path.
runner_run_dir() {
    printf '%s/codeferret' "$RUNNER_TEMP"
}

# Where /codeferret:review puts a run: inside the git dir, so it is never in the tree under
# review and never in a sibling worktree of it.
session_run_dir() {
    printf '%s/codeferret/run' "$(git rev-parse --absolute-git-dir)"
}

# Where a caller leaves the token run.sh's two GitHub fetches need, given the run directory.
#
# Beside that directory and not inside it: build-prompts.sh deletes the run directory whole
# before it writes anything, and will not start against one it did not write itself.
#
# Every caller and both of the action's steps go through this function, because a token left
# under one path and looked for under another is a review that reports every earlier comment
# as new, with one line on stderr to say so.
token_file() {
    printf '%s.token' "$1"
}

# ---- Reaching a containerised toolchain ---------------------------------------------

# Whether `command-prefix` can see a path at the same place the runner has it.
#
# A prefix mounts only what whoever wrote it was told to mount, and a run reads paths outside
# the checkout. Each is named here, because a missing action path shows up in the first
# seconds as a bun module-resolution error, and a missing build directory shows up much
# later, with every lens reading no diff at all and the review coming back empty for no
# stated reason.
#
# Each call has to sit after the path exists on the runner and before the first `$PREFIX
# bun` that would create it inside the container. Bun.write makes parent directories, so one
# such call is all it takes for `test -d` to answer yes about a directory only the container
# has.
prefix_reaches() {
    if [ -z "${PREFIX:-}" ]; then
        return 0
    fi

    if $PREFIX test -d "$1"; then
        return 0
    fi

    echo "the command prefix cannot reach $1. Mount it in the container at that same path." >&2
    exit 1
}

# ---- What gh and git can tell a local run -------------------------------------------

# What the scripts a session runs hand to fetch-existing.ts, fetch-previous.ts and
# post-review.ts. Both callers pass the same two values, taken from the same tool: a token
# read one way and a repository name read another can name two different repositories.
#
# Empty on failure: without gh a review still runs and prints, and it is the caller that
# decides whether what it is about to do needs the credential.
gh_credentials() {
    GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
    GITHUB_REPOSITORY=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
    export GITHUB_TOKEN GITHUB_REPOSITORY
}

# The open pull request this branch has, as PR, PR_BASE and PR_HEAD. Each is empty where
# there is none, or where gh cannot answer.
#
# One `gh pr view` for all three, and only an open pull request counts: gh answers with the
# closed or merged one a branch used to have, which would name a base nobody is working
# from now and offer to post a review onto something nobody is reading.
#
# Exported because run.sh reads `PR` out of its environment, and the three travel together.
open_pr() {
    local line

    PR=""
    PR_BASE=""
    PR_HEAD=""
    export PR PR_BASE PR_HEAD

    command -v gh >/dev/null 2>&1 || return 0

    line=$(gh pr view --json number,baseRefName,headRefOid,state \
        --jq 'select(.state == "OPEN") | [.number, .baseRefName, .headRefOid] | @tsv' 2>/dev/null || true)

    PR=$(printf '%s' "$line" | cut -f1)
    PR_BASE=$(printf '%s' "$line" | cut -f2)
    PR_HEAD=$(printf '%s' "$line" | cut -f3)
}

# Origin's default branch name, or nothing. Answered once per shell, because the fallback
# is a network call.
default_branch() {
    if [ -z "${CF_DEFAULT_BRANCH+set}" ]; then
        CF_DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
        CF_DEFAULT_BRANCH=${CF_DEFAULT_BRANCH#origin/}

        if [ -z "$CF_DEFAULT_BRANCH" ] && command -v gh >/dev/null 2>&1; then
            CF_DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)
        fi
    fi

    printf '%s' "$CF_DEFAULT_BRANCH"
}


# The ref a review diffs against: what the caller named, then the open pull request's base,
# then origin's default branch. Empty when none of the three answers. Call `open_pr` first.
#
# In commands/review.md the model is told not to relay the base the preflight printed to the
# run that reviews under it, on the grounds that both work it out the same way. Both callers
# run this function, so they cannot disagree. If they did, every lens would read the wrong
# range for twenty minutes while the preflight output the user was shown named a different
# base.
resolve_base() {
    local default

    if [ -n "${1:-}" ]; then
        printf '%s' "$1"
        return 0
    fi

    if [ -n "${PR_BASE:-}" ]; then
        printf 'origin/%s' "$PR_BASE"
        return 0
    fi

    default=$(default_branch)

    [ -n "$default" ] && printf 'origin/%s' "$default"

    return 0
}

# ---- Guards on the values a model pastes into a command line -------------------------
#
# /codeferret:review has a model substitute a base ref, a lens name and a tool name into
# the shell it runs, and the action takes the same three from workflow inputs. Quoting is
# no defence: `$(...)`, backticks and `${...}` all expand inside double quotes. So a value
# that is not a plain ref or a plain name never reaches a command line.
#
# Both classes are deliberately narrower than git allows. `git check-ref-format` accepts
# `$`, `(`, `)`, a backtick, `;`, `&` and `|`, so a ref name can run on substitution. A
# legal ref this turns away is a refusal the caller can see and rename around.

# A git ref: the plain-name set plus `/`. A leading `-` is barred separately, because it
# is legal in a ref name and git would read it as an option.
plain_ref() {
    case $1 in
    "" | -* | *[!A-Za-z0-9._/-]*) return 1 ;;
    *) return 0 ;;
    esac
}

# A pull request number. It becomes a `gh pr view` argument, where a leading `-` is read as
# a flag, and the scripts it is handed on to put it in a REST path.
plain_number() {
    case $1 in
    "" | *[!0-9]*) return 1 ;;
    *) return 0 ;;
    esac
}

# A lens or tool name. It becomes a path component under two search roots, a `cp -R`
# destination and a line of a prompt, so no separator and no leading dot.
plain_name() {
    case $1 in
    "" | .* | *[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
    esac
}

# A filesystem path or a pathspec glob. This bars the characters that would run as shell
# rather than allowing a set, because a path holds spaces and non-ASCII where a ref name
# does not.
#
# The newline is barred for a second reason. local-preflight.sh runs every path it reports
# through this and then prints it as one `key=value` line, which a model reads and acts on,
# so a value carrying a newline forges the answers below it: `pushed=yes` and `dirty=0` are
# what unlock posting. A newline is legal in a directory name on every platform this runs
# on.
#
# An alternation of quoted patterns rather than one bracket expression: semgrep's bash
# grammar cannot read a bracket expression in a case pattern and gives up on the whole
# construct, while still reporting the file as scanned.
plain_path() {
    local newline='
'

    case $1 in
    "" | *"'"* | *'"'* | *';'* | *'$'* | *'`'* | *"\\"* | *'&'* | *'|'* | *'<'* | *'>'* | *"$newline"*) return 1 ;;
    *) return 0 ;;
    esac
}
