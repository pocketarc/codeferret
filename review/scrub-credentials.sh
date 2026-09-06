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

# What removal knows how to act on. Each names one storage shape and drives one branch of
# `scrub_repo`. `extraheader` allows the bare `http.extraheader`, which is legal and which the
# earlier `^http\..*\.extraheader$` needed a middle segment to match.
HEADER='^http\.(.*\.)?extraheader$'
INCLUDES='^includeif\..*\.path$'
URLS='^(remote|submodule)\..*\.url$'
REWRITES='^url\..*\.insteadof$'

# What proof of removal looks for, and it is deliberately not the list above.
#
# Three reviews found this script reporting a clean workspace over a live token, each time a
# shape the patterns did not name: the wrong storage mechanism entirely, then a token in a
# remote's url, then the bare `http.extraheader` key and a credential sitting in the *key* of a
# `url.<base>.insteadOf` rewrite. Every fix was right and every one left another hole, because a
# read-back that asks "do these key names appear" can only find shapes somebody thought of.
#
# So proof asks the other question: is there anything token-shaped anywhere in this config. It
# reads whole `key=value` lines, which is what catches a credential in a key, and it matches on
# what a credential looks like rather than on where one is kept. A shape nobody has thought of
# still fails the step, and fails it loudly, which is the direction to be wrong in: removal can
# lag detection, and a run that cannot clean what it found stops rather than certifying it.
CREDENTIAL='(AUTHORIZATION:|://[^/[:space:]]*:[^/[:space:]]*@|gh[psour]_|github_pat_)'

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
# Rewrites every url carrying a credential, and reports through its exit status whether it
# rewrote any. Success means it found one, which is the inverse of the usual reading and is why
# the caller is written as a plain `if` rather than a test against a variable: the alternative
# was an undeclared global set deep inside the loop, invisible to a reader of either function
# and one `local` away from silently never propagating, which would leave the reflog purge
# unrun with the url still in it.
scrub_urls() {
    local key value seen="" cleaned dirty found=1

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
        found=0
    done < <(git config --local --name-only --get-regexp "$URLS" || true)

    return "$found"
}

# `--local` on every read here: this is the file being edited, and a read that expanded an
# include would report a key `--unset-all` cannot remove.
#
# Prints one line per thing it removed. The count is not kept in a variable, because `--one`
# runs in a child of the shell that reports: a run where only a submodule held a credential
# printed that it had scrubbed one and that nothing had been reachable, in that order.
scrub_repo() {
    local key path

    if scrub_urls; then
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

    # A rewrite rule keeps the credential in its own key, so there is no value to clean and the
    # key goes. `url.https://x-access-token:$TOKEN@github.com/.insteadOf = https://github.com/`
    # is the documented recipe for cloning a private submodule, which is the same `checkout:
    # skip` case action.yml sends a caller to.
    while IFS= read -r key; do
        [ -n "$key" ] || continue
        git config --local --unset-all "$key" || true
        echo "removed a rewrite rule carrying a credential from $(pwd)"
    done < <(git config --local --name-only --get-regexp "$REWRITES" || true)
}

# What is still reachable here, read the way a lens would read it: no `--local`, so includes
# are expanded and the global and system files are in scope too. The origin is printed because
# a value in a file this script cannot edit still has to be named.
#
# Every mechanism the scrub covers is read back, because the read-back is the whole of the
# evidence and one it does not cover is one the script reports a clean workspace over. A url
# key is named only where its value carries userinfo, since most of them are ordinary remotes,
# and the value itself is dropped: the caller prints this to a job log.
# Anything printed, with the credential taken out of it.
#
# Naming the key and withholding the value was the first rule here and it was wrong on the one
# shape this script had just been taught: `url.<base>.insteadOf` keeps the credential in the
# key, so a rewrite rule the removal could not reach was written to the step log in full. On a
# public repository that log is world-readable, and a token minted inside the job rather than
# read from `secrets.*` is not masked by Actions.
#
# The substitutions are the `CREDENTIAL` alternatives again, one to one, so anything detection
# can find redaction can hide. Adding a shape to one without the other is the way this leaks
# next, and `scrub-credentials.test.ts` pins that both know each shape.
redact() {
    printf '%s' "$1" | sed -E \
        -e 's#://[^/@[:space:]]*:?[^/@[:space:]]*@#://REDACTED@#g' \
        -e 's#(gh[psour]_|github_pat_)[A-Za-z0-9_]+#\1REDACTED#g' \
        -e 's#([Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]:).*#\1 REDACTED#g'
}

reachable() {
    local line origin rest

    # `--show-origin --list`, so every line is `origin<TAB>key=value` and the whole of it is
    # tested. Testing the key alone is what let a credential sitting in the key of a rewrite
    # rule through; testing named keys alone is what let three other shapes through.
    #
    # No `--local`. A lens reads the config git resolves, which expands `includeIf` and takes
    # in the global and system files, and a value this script cannot edit still has to be
    # named rather than passed over. The origin is printed for that reason.
    while IFS= read -r line; do
        origin=${line%%$'\t'*}
        rest=${line#*$'\t'}

        if printf '%s' "$rest" | grep -Eqi "$CREDENTIAL"; then
            printf '%s\t%s\n' "$origin" "$(redact "${rest%%=*}")"
        fi
    done < <(git config --show-origin --list 2>/dev/null || true)
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
# Every repository in the workspace, not the checkout and its submodules alone. A second
# `actions/checkout` with `path:` puts a whole repository beside this one, which is an ordinary
# way to arrange the `checkout: skip` case action.yml sends a caller to, and it keeps its own
# config. Neither the sweep nor the read-back visited it: `reachable` runs from the workspace
# root and reads that repository's config, the global and the system, and nothing one directory
# down. The step printed a clean workspace over it.
#
# `.git` matches a directory in an ordinary clone and a file in a submodule, and git resolves
# either, so one walk covers both. The submodule pass stays beside it because `foreach` reaches
# a submodule whose working tree is not checked out, which has no `.git` to find.
#
# `node_modules` and `.git` itself are pruned. A package manager writes thousands of
# directories and a git directory holds no nested repository, and walking either costs the run
# for nothing.
repositories() {
    # `-print` before `-prune`, so a match is reported and then not descended into. With the
    # prune first the test consumes the match and the walk prints nothing at all, which reads
    # exactly like a workspace holding one repository.
    find "$WORKSPACE" -name node_modules -prune -o -name .git -print -prune 2>/dev/null |
        while IFS= read -r found; do dirname "$found"; done
}

each_repository() {
    local dir

    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        bash "$SELF" "$1" "$dir" 2>/dev/null || true
    done < <(repositories)
}

removed=$(
    scrub_repo
    each_repository --one
    git submodule foreach --recursive --quiet "bash '$SELF' --one \"\$PWD\"" 2>/dev/null || true
)

# Deduplicated, because the three passes overlap on purpose. The walk finds the workspace's own
# repository as well as any beside it, and every pass reads the global and system files, so one
# credential in `~/.gitconfig` is found once per repository. Reporting it once is the whole of
# what this changes: the passes stay wide, since narrowing them to make the report tidy is how
# a shape goes unlooked-for.
left=$(
    {
        reachable
        each_repository --check-one
        git submodule foreach --recursive --quiet "bash '$SELF' --check-one \"\$PWD\"" 2>/dev/null || true
    } | sort -u
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
