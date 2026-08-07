Review this repository's diff against `__BASE__`:

    bash __DIFF_SCRIPT__
    git log __BASE__..__HEAD__ --oneline

The first prints the diff under review. Its arguments are the NUL-separated list in
`__DIFF_ARGS__`, which excludes generated files.

To read one file on its own, run `git diff __RANGE__ -- <path>`. Do not add a path to the
list in `__DIFF_ARGS__`, and do not edit that file: what comes back would be the whole diff
rather than the file you asked for.
