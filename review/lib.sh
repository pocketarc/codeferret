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

# A git ref: the plain-name set plus `/`. A leading `-` is barred separately, because it
# is legal in a ref name and git would read it as an option.
plain_ref() {
    case $1 in
    "" | -* | *[!A-Za-z0-9._/-]*) return 1 ;;
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

# A filesystem path. Whoever cloned the repository chose it rather than whoever opened the
# pull request, so this bars the characters that would run as shell rather than allowing a
# set: a path holds spaces and non-ASCII where a ref name does not.
plain_path() {
    case $1 in
    "" | *"'"* | *'"'* | *';'* | *'$'* | *'`'* | *"\\"* | *'&'* | *'|'* | *'<'* | *'>'*) return 1 ;;
    *) return 0 ;;
    esac
}
