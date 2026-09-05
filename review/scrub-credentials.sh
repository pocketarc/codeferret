#!/usr/bin/env bash
# Take the checkout's credential back out of the workspace, before a lens can read it.
#
# `run.sh` starts the orchestrator inside the workspace and every lens has `Bash`, so a
# credential reachable from the checkout is a credential a lens reads. review/DECISIONS.md,
# under "The GitHub token never enters the step that runs the agent", has the argument.
#
# A checkout stores it in several places, and every one of them has to go.
#
#   1. `http.<server>.extraheader` in the repository's own config. What older versions of
#      `actions/checkout` write.
#   2. An `includeIf.gitdir:<workspace>/.git.path` in the repository's config, pointing at a
#      credentials file under `$RUNNER_TEMP` with the header inside it. This is what v6.0.2
#      does. The file is removed rather than dereferenced, because a lens reads it directly
#      whether or not any git config still points at it.
#   3. Userinfo in the url itself, as `remote.<name>.url` or `submodule.<name>.url`. This is
#      what `git clone https://x-access-token:$TOKEN@github.com/...` leaves, which is an
#      ordinary way to check a repository out by hand under `checkout: skip`. The url is
#      rewritten to its credential-free form rather than deleted, so the remote still resolves.
#
# `git config --local` does not expand `includeIf`, and a plain read does. Both were measured,
# and so was what the difference costs: the version of this script that went looking for the
# second shape with `--local` matched no key, read back no key, and exited 0 over a live
# credential for a whole review. So a scrub that reports nothing is not evidence that there
# was nothing to scrub. The third shape cost the same way, and no case had gone red over it: a
# token in a url is not an `extraheader`, so neither the removal nor the read-back covered it.
#
# Rewriting a url does not reach every copy git took of it. `git clone` writes the url it was
# given into the reflog message, and `git fetch` writes it into `FETCH_HEAD`, both as plain
# text a lens reads with `cat`. So a repository whose url carried userinfo has its reflogs and
# its `FETCH_HEAD` emptied as well; neither is read by anything a review does. What stays out
# of reach is a credential the branch itself committed, which is part of the diff and a finding
# for a lens rather than this script's to remove, and a `credential.helper` the caller
# configured, whose store this script neither writes nor knows the shape of.
#
# Nothing here is decided by a file in the tree under review. The submodule pass ran behind a
# `[ -f .gitmodules ]` guard until that was measured too: `git submodule foreach --recursive`
# walks the index and `submodule.<name>.url`, so it visits a submodule with that file deleted,
# and the file is tracked in the branch this action reviews. The same guard stood in front of
# the verification, so deleting it took the scrub and the proof of the scrub together.
#
# A script rather than a `run:` block, for the reason review/refuse-fork.sh gives. Whether this
# removes anything is not visible in its syntax, so what it decides is a table of cases in
# review/scrub-credentials.test.ts, which runs this script against a config built the way
# checkout builds one.
#
# Usage: scrub-credentials.sh <workspace>
#        scrub-credentials.sh --one <dir>     one repository, no recursion
#        scrub-credentials.sh --check-one <dir>   what is still reachable there
#
# Exit: 0 nothing is reachable any more, or there is no repository at all,
#       1 something survived, or the workspace is not there.
set -uo pipefail

SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")

HEADER='^http\..*\.extraheader$'
INCLUDES='^includeif\..*\.path$'
URLS='^(remote|submodule)\..*\.url$'

# The authority alone, so a `@` anywhere in the path does not count. Only `http` and `https`, so
# the `git@` of an ssh remote is left alone: it is a username with no secret behind it, and
# stripping it would leave a remote that no longer resolves.
has_userinfo() {
    local authority

    case "$1" in
    http://* | https://*) ;;
    *) return 1 ;;
    esac

    authority=${1#*://}
    authority=${authority%%/*}

    case "$authority" in
    *@*) return 0 ;;
    *) return 1 ;;
    esac
}

# Only ever called behind `has_userinfo`.
strip_userinfo() {
    local rest=${1#*://}

    printf '%s://%s\n' "${1%%://*}" "${rest#*@}"
}

# Where git would look for an include, given the path written in the config.
#
# `[ -f "$path" ]` on the raw value was the first version and it missed two spellings git
# accepts: `~/creds` and a path relative to the directory of the config file holding the
# include. Both resolve for git and not for the test, so the key came off, the read-back came
# back clean, and the file stayed on disk. `actions/checkout` writes an absolute path, so this
# is a shape nobody has produced here yet rather than one that has bitten.
resolve_include() {
    local path=$1

    case "$path" in
        \~/*) printf '%s\n' "$HOME/${path#\~/}" ;;
        /*) printf '%s\n' "$path" ;;
        *) printf '%s\n' "$(dirname "$(git rev-parse --absolute-git-dir)/config")/$path" ;;
    esac
}

# What a clone or a fetch recorded of the url it used, emptied.
#
# `git clone` writes "clone: from <url>" into the reflog of HEAD and of the branch it checked
# out, and `git fetch` writes the url into `FETCH_HEAD`. Both are plain text under the git
# directory, so a rewritten `remote.origin.url` leaves the token a lens can still read with
# `cat`. Nothing a review does reads either: the diff is taken from refs, and a fetch writes
# `FETCH_HEAD` afresh.
#
# Only reached where a url carried userinfo, so an ordinary run keeps its reflogs.
purge_url_traces() {
    local gitdir log

    gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) || return 0

    rm -f "$gitdir/FETCH_HEAD"

    if [ -d "$gitdir/logs" ]; then
        while IFS= read -r log; do
            : >"$log"
        done < <(find "$gitdir/logs" -type f)
    fi

    echo "emptied FETCH_HEAD and the reflogs in $gitdir, which hold the url a clone or a fetch used"
    echo "a credential the branch committed into its own tree stays where it is:" \
        "that is part of the diff, and a finding for a lens rather than this script's to remove"
}

# A url key is rewritten rather than removed, and every value of it: `remote.<name>.url` takes
# more than one, and unsetting the key would leave a remote that resolves to nothing. The key
# list is deduplicated because `--name-only` prints a multi-valued key once per value.
#
# The value never reaches the output. It is the credential, and everything printed here goes
# into a job log a run publishes.
scrub_urls() {
    local key value seen="" cleaned dirty

    while IFS= read -r key; do
        [ -n "$key" ] || continue

        case " $seen " in *" $key "*) continue ;; esac
        seen="$seen $key"

        cleaned=()
        dirty=0

        while IFS= read -r value; do
            if has_userinfo "$value"; then
                dirty=1
                cleaned+=("$(strip_userinfo "$value")")
            else
                cleaned+=("$value")
            fi
        done < <(git config --local --get-all "$key" || true)

        [ "$dirty" = 1 ] || continue

        git config --local --unset-all "$key" || true

        for value in "${cleaned[@]}"; do
            git config --local --add "$key" "$value"
        done

        echo "rewrote $key in $(pwd) without the credential embedded in it"
        URL_SCRUBBED=1
    done < <(git config --local --name-only --get-regexp "$URLS" || true)
}

# `--local` on every read here: this is the file being edited, and a read that expanded an
# include would report a key `--unset-all` cannot remove.
#
# Prints one line per thing it removed. The count is not kept in a variable, because `--one`
# runs in a child of the shell that reports: a run where only a submodule held a credential
# printed that it had scrubbed one and that nothing had been reachable, in that order.
scrub_repo() {
    local key path

    URL_SCRUBBED=0
    scrub_urls

    if [ "$URL_SCRUBBED" = 1 ]; then
        purge_url_traces
    fi

    while IFS= read -r key; do
        [ -n "$key" ] || continue
        git config --local --unset-all "$key" || true
        echo "removed $key from $(pwd)"
    done < <(git config --local --name-only --get-regexp "$HEADER" || true)

    while IFS= read -r key; do
        [ -n "$key" ] || continue

        path=$(git config --local --get "$key" || true)

        if [ -n "$path" ]; then
            path=$(resolve_include "$path")

            # A checkout writes one set of these for the runner's paths and another for the
            # container's, so a path that is not there is the ordinary case rather than a fault.
            if [ -f "$path" ]; then
                rm -f "$path" || true
                echo "removed the credentials file $path"
            fi
        fi

        git config --local --unset-all "$key" || true
        echo "removed $key from $(pwd)"
    done < <(git config --local --name-only --get-regexp "$INCLUDES" || true)
}

# What is still reachable here, read the way a lens would read it: no `--local`, so includes
# are expanded and the global and system files are in scope too. The origin is printed because
# a value in a file this script cannot edit still has to be named.
#
# Every mechanism the scrub covers is read back, because the read-back is the whole of the
# evidence and one it does not cover is one the script reports a clean workspace over. A url
# key is named only where its value carries userinfo, since most of them are ordinary remotes,
# and the value itself is dropped: the caller prints this to a job log.
reachable() {
    local line origin key value

    git config --show-origin --name-only --get-regexp "$HEADER" 2>/dev/null || true

    while IFS= read -r line; do
        origin=${line%%$'\t'*}
        key=${line#*$'\t'}
        value=${key#* }
        key=${key%% *}

        if has_userinfo "$value"; then
            printf '%s\t%s\n' "$origin" "$key"
        fi
    done < <(git config --show-origin --get-regexp "$URLS" 2>/dev/null || true)
}

case "${1:-}" in
    --one)
        cd "${2:-.}" || exit 1
        scrub_repo
        exit 0
        ;;
    --check-one)
        cd "${2:-.}" || exit 1
        reachable
        exit 0
        ;;
esac

WORKSPACE=${1:-}

if [ -z "$WORKSPACE" ]; then
    echo "usage: scrub-credentials.sh <workspace>" >&2
    exit 1
fi

# Not skipped when the directory is missing. A quiet exit here leaves a credential where a
# lens can read it if the reasoning behind that exit is ever wrong, so the one case that
# exits 0 is named below and every other one fails.
cd "$WORKSPACE" || exit 1

# The named case: a caller who passed `checkout: skip` and has not cloned yet. With no
# repository there is no config, and so nothing holding a credential.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "no checkout in $WORKSPACE, so nothing holds a credential yet" >&2
    exit 0
fi

# Both passes re-exec this script rather than inlining a copy of either loop, so a submodule
# and a superproject are scrubbed and checked by the same code, and the two regexes above stay
# the only spelling of what a credential looks like. `foreach` over a repository with no
# submodules costs one process and exits 0.
removed=$(
    scrub_repo
    git submodule foreach --recursive --quiet "bash '$SELF' --one \"\$PWD\"" 2>/dev/null || true
)

left=$(
    reachable
    git submodule foreach --recursive --quiet "bash '$SELF' --check-one \"\$PWD\"" 2>/dev/null || true
)

if [ -n "${left//[[:space:]]/}" ]; then
    echo "a git credential is still reachable from $WORKSPACE, and a lens reads that tree:" >&2
    printf '%s\n' "$left" >&2
    exit 1
fi

if [ -n "${removed//[[:space:]]/}" ]; then
    printf '%s\n' "$removed"
    echo "took the checkout's credential out of the workspace"
else
    echo "no git credential was reachable from $WORKSPACE"
fi
