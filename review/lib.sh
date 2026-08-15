# shellcheck shell=bash
# What more than one of this repository's shell scripts needs. Sourced, never run.

# ---- Reading a newline-separated input -----------------------------------------------

# A newline-separated value on stdin, as one trimmed name per line with the blanks dropped.
#
# One reader for the shell, because the run is wrong when two of them disagree.
# build-prompts.sh reads its lens list through this and select-lenses.ts subtracts from the
# same list, so a name trimmed on one side and not the other is an exclusion reported as
# matching nothing while the lens runs. `lines` in review/lines.ts is the same three steps for
# the TypeScript side, and the copies this replaced had already drifted: one trimmed
# `[:blank:]` and the other `[:space:]`, which is the difference between keeping a carriage
# return and dropping it.
trim_lines() {
    sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | grep -v '^$' || true
}

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

# ---- The file the orchestrator is handed, and what replaces it afterwards -------------

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

# What existing.json says when the fetch meant to write it failed before it wrote anything at
# all: the same shape as `empty_existing`, naming why.
#
# Not what a *partial* failure leaves. fetch-existing.ts writes `error` or `conversation_error`
# itself, ahead of exiting non-zero, when one half of the fetch failed and the other did not;
# `fetch_existing` below checks for that and leaves it alone. This is for the failure that the
# script cannot report on its own: a crash, a missing `bun`, an exit before line one runs. Then
# the path this writes to still holds whatever `run.sh` put there before the session, which is
# `empty_existing`'s output and carries neither field, so `unreadOf` stays silent and
# `vetSuppression` reopens every suppression resting on this file with nothing on the page
# saying why.
failed_existing() {
    printf '{"threads": [], "conversation": [], "error": "%s"}\n' "$2" >"$1"
}

# What previous.json says when there was no pull request to fetch it from, when the fetch came
# back with nothing, or when the copy on disk is the session's own work rather than the fetch's.
#
# Beside `empty_existing` and for its reason. `filesRaisedBefore` reads a missing `findings` as
# an empty set, so a copy that drifts costs nothing visible and reopens every suppression that
# cited no comment.
empty_previous() {
    printf '{"findings": []}\n' >"$1"
}

# ---- Running one of this run's scripts, with a credential and across a container boundary ----

# One of the scripts under `review/`, given the environment it needs and nothing else. The
# token comes in on stdin.
#
# `docker compose exec` starts a process with the container's environment rather than this
# shell's, so under `command-prefix` every value a script reads has to be named. `GITHUB_TOKEN`
# is emptied rather than passed, because `tokenFromStdinOrEnv` reads the environment ahead of
# stdin: a job or a developer's shell exporting one of its own would otherwise decide which
# account read the pull request or posted the review, with nothing said either way. The token
# goes over stdin, which `-T` passes through, rather than into an argument list every other
# process on the machine can read. And `--config=/dev/null`, like every other bun a run starts.
#
# One home because each of those is easy to leave out and none of them fails visibly. It was
# written out three times, and one of the three had the pipe and not the blanking: under
# `command-prefix` that reads the previous run's artifact as the container's own account, which
# shows up only as findings repeated or suppressed.
#
# Anything a script needs beyond the two named here is an assignment the caller passes, so a
# variable it forgot is a variable the script finds empty rather than one this shell happens
# to hold.
#
# Usage: run_tool <root> <script> [<NAME=value>...] -- <args...>, token on stdin.
run_tool() {
    local root=$1 script=$2
    shift 2

    local passed=("GITHUB_TOKEN=" "GITHUB_REPOSITORY=${GITHUB_REPOSITORY:-}")

    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
        passed+=("$1")
        shift
    done

    if [ "$#" -gt 0 ]; then
        shift
    fi

    ${PREFIX:-} env "${passed[@]}" bun --config=/dev/null "$root/review/$script" "$@"
}

# What puts a real one back, once the session has exited. The token comes in on stdin.
#
# The orchestrator is handed this path in the same prompt as the rule `vetSuppression`
# applies, so the copy it was given is not evidence about the session, and run.sh empties the
# file rather than leaving it. This fetch is what the vetting reads instead, and it carries
# whatever was said during the review as well.
#
# Here rather than in run.sh, which is the script that starts the agent. A token that script
# still held afterwards would go to a `bun` the session has had a whole review to overwrite,
# and to a script under the action path it could have rewritten just as easily. So the fetch
# belongs to the post and print paths, each of which already holds a credential for its own
# work and runs once the session is gone.
#
# Usage: fetch_existing <root> <build-dir> <pr> [<own-login>], token on stdin.
fetch_existing() {
    local root=$1 build=$2 pr=$3 login=${4:-}
    local target="$build/existing.json"

    if ! run_tool "$root" fetch-existing.ts -- "$pr" "$target" ${login:+"$login"}; then
        echo "could not read all of this pull request's comments. Whatever went unread counts as new." >&2

        # A whole-process failure only: `grep` finds `error"` in what fetch-existing.ts wrote
        # itself for a partial one, which is the more precise reason and stays.
        if ! grep -q 'error"' "$target" 2>/dev/null; then
            failed_existing "$target" "the fetch failed before it could read anything"
        fi
    fi
}

# What the last run raised, out of its `codeferret-run` artifact. The token comes in on stdin.
#
# Called twice by the action, before the session and again from the posting step, for the
# reason written above `fetch_existing`: `vetSuppression` decides against this file too, and
# the session was handed the path to its own copy of it. `local-post.sh` and `local-print.sh`
# do not call it, because `ownWorkflow` in fetch-previous.ts answers null where nothing names a
# workflow and every artifact is then refused, so the second call would spend requests to write
# the empty form run.sh has already written.
#
# Reading it needs `actions: read`. The shipped workflow grants it and a consumer can decline
# it, so an empty answer is allowed: fetch-previous.ts reports its own failures, and the
# caller's `||` is for a failure before it can.
#
# Usage: fetch_previous <root> <build-dir> <pr>, token on stdin.
fetch_previous() {
    local root=$1 build=$2 pr=$3

    run_tool "$root" fetch-previous.ts "GITHUB_RUN_ID=${GITHUB_RUN_ID:-}" \
        -- "$pr" "$build/previous.json" ||
        echo "could not read the previous run's findings. Every finding will count as new." >&2
}

# ---- Where a run keeps its files ----------------------------------------------------

# Where a run keeps its files, as RUN_DIR, BUILD_DIR and SESSION_DIR.
#
# `build/` is the one name every part of a run has to agree on. Rename it here and leave it
# spelled out by hand somewhere else, and a review runs, costs the money, and posts against a
# diff nothing read. The pathspec was built twice once and drifted, which is why
# review/diff-args.ts exists; this is the same fact one level up.
#
# `session/` holds the copies the review session is handed, and it exists so that the two jobs
# the build directory used to do have a directory each. Everything a run decides afterwards
# reads `build/`, no prompt names it, and nothing is copied back: what the session was given
# is a copy, and a copy it rewrote costs it nothing but its own reading. `artifact-path`
# resolves against `build/`, so the session's directory is in no artifact either.
#
# The root is the caller's: `runner_run_dir` on a runner, `session_run_dir` on somebody's
# own machine.
run_dirs() {
    RUN_DIR="$1"
    BUILD_DIR="$1/build"
    SESSION_DIR="$1/session"
    export RUN_DIR BUILD_DIR SESSION_DIR
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

# Put a token where run.sh will look for it, given the run directory. The value comes in on
# stdin, the way `fetch_existing` takes one.
#
# The mode and the refusal are security properties rather than tidiness, and both callers had
# them written out by hand. Two copies that agree today are one edit away from two that do
# not, and neither a token written world-readable nor one written into a file another account
# left in place is a failure anything here would report.
#
# `rm -f` and then `>` is not an exclusive create. A symlink planted at the path in between
# is followed by the redirect, the token lands on whatever the link points at under whatever
# mode that file already has, and `umask` governs only a file the shell creates, which that
# one is not. `noclobber` makes the open itself O_EXCL: measured, a link left there is refused
# with "cannot overwrite existing file" and its target is untouched. The `rm -f` stays for the
# ordinary second run.
#
# `mkdir` moved inside the umask because it was creating the parent at the ambient umask,
# 0755 on a runner, which is what a local account needs to plant that link in the first
# place.
#
# Usage: stage_token <run-dir>, token on stdin.
stage_token() {
    local file
    file=$(token_file "$1")

    (
        umask 077
        mkdir -p "$(dirname "$file")"
        rm -f "$file"
        set -o noclobber
        cat >"$file"
    )
}

# ---- What a run's findings have to clear before anything reads them ------------------

# The two guards in front of a run's findings: the file is there, and check-findings.ts has
# passed it.
#
# One home because the pair is one fact, and both local scripts asked it in the same words
# down to the hint line. run.sh writes `findings-checked` only where the check passed, and the
# action posts on nothing else. Printing is held to the same bar as posting because it reaches
# the same fields: `readMerged` checks that `findings` is an array and nothing more, and
# print-findings.ts then calls `.localeCompare` on a finding's file and `.replace` on a lens
# name, which nothing else narrows, so a `lens_health` entry naming its lens as a number ends
# a run that cost real money in a TypeError. That gate used to be a step of
# commands/review.md, and prose is not a boundary.
#
# Usage: require_checked_findings <build-dir> <plugin-root> <verb>
require_checked_findings() {
    local build=$1 plugin=$2 verb=$3
    local findings="$build/findings.json"

    if [ ! -f "$findings" ]; then
        echo "no findings at $findings. Run the review first." >&2
        return 1
    fi

    if [ ! -f "$build/findings-checked" ]; then
        echo "$findings did not pass check-findings.ts, so it is not safe to $verb." >&2
        # With the flag, like every other bun a run starts. Whoever reads this line is
        # standing in the checkout under review, which is the directory bun takes a
        # `bunfig.toml` from.
        echo "run: bun --config=/dev/null '$plugin/review/check-findings.ts' '$findings'" >&2
        return 1
    fi
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

# The account a local run posts under, which is what marks a thread `mine`. Empty where gh
# cannot answer, and `fetch-existing.ts` then falls back to `github-actions`.
#
# Every local path that reads the pull request goes through this. The run before the session
# derived it and the two refetches afterwards passed nothing, so the same threads came back
# marked against a different login from the one the orchestrator judged them under. Nothing
# reads `mine` locally today, because both scripts set `RESOLVE_THREADS=0`; a divergence that
# costs nothing until it does is one nobody finds on the day it starts costing something.
own_login() {
    gh api user --jq .login 2>/dev/null || true
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

# How many tracked files are uncommitted, as a bare number.
#
# What it decides is whether a review still describes the tree the lenses read. They read the
# working tree as they find it, so a review taken over a dirty one quotes lines that are in no
# commit and sends a reader of the pull request to code GitHub does not hold.
#
# Untracked files are left out. Nothing untracked reaches a diff, so counting one would block
# posting over a scratch file.
dirty_tracked() {
    git status --porcelain --untracked-files=no | wc -l | tr -d '[:space:]'
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
# /codeferret:review has a model substitute a base ref and a lens name into the shell it
# runs, and the action takes both from workflow inputs. Quoting is
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

# A lens name. It becomes a path component under two search roots, a `cp -R` destination
# and a line of a prompt, so no separator and no leading dot.
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
# The barred set is one string so that a reader can check it against the paragraphs above. It
# was ten alternated patterns while semgrep was in the toolchain: semgrep's bash grammar gave
# up on a bracket expression in a `case` pattern and reported the file as scanned anyway.
# `e40aa7d` took semgrep out. The two forms were compared over the ten characters, the
# newline, and twenty-odd legal paths before this one replaced the other, and they agreed on
# every row.
plain_path() {
    local barred=$'\'";$`\\&|<>\n'

    case $1 in
    "" | *["$barred"]*) return 1 ;;
    *) return 0 ;;
    esac
}
