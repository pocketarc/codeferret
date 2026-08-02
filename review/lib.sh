# shellcheck shell=bash
# Guards for the values a model pastes into a command line. Sourced, never run.
#
# /codeferret:review has a model substitute a base ref, a lens name and a tool name into
# the shell it runs, and the action takes the same three from workflow inputs. Quoting is
# no defence: `$(...)`, backticks and `${...}` all expand inside double quotes. So a value
# that is not a plain ref or a plain name never reaches a command line.
#
# Both classes are deliberately narrower than git allows. `git check-ref-format` accepts
# `$`, `(`, `)`, a backtick, `;`, `&` and `|`, so a ref name can run on substitution. A
# legal ref this turns away is a refusal the caller can see and rename around.
#
# One copy, because four hand-copied allowlists is four chances for one of them to drift
# into a hole.

# The lens the static analysis tools report to, and the only one that reads their reports.
# Declared once, because two scripts decide what to run by matching this name against a
# lens list, and validate-manifests.ts checks the action's defaults against it.
export TOOLS_LENS=static-analysis

# What the scripts a session runs hand to fetch-existing.ts, fetch-previous.ts and
# post-review.ts. Both callers pass the same two values, taken from the same tool: a token
# read one way and a repository name read another can name two different repositories.
#
# Empty on failure rather than fatal: without gh a review still runs and prints, and it is
# the caller that decides whether what it is about to do needs the credential.
gh_credentials() {
    GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
    GITHUB_REPOSITORY=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
    export GITHUB_TOKEN GITHUB_REPOSITORY
}

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
# An alternation of quoted patterns rather than one bracket expression: semgrep's bash
# grammar cannot read a bracket expression in a case pattern and gives up on the whole
# construct, while still reporting the file as scanned.
plain_path() {
    case $1 in
    "" | *"'"* | *'"'* | *';'* | *'$'* | *'`'* | *"\\"* | *'&'* | *'|'* | *'<'* | *'>'*) return 1 ;;
    *) return 0 ;;
    esac
}
