Review this repository's diff against `__BASE__`:

    bash __DIFF_SCRIPT__
    git log __BASE__..__HEAD__ --oneline

The first prints the diff under review. Its arguments are the NUL-separated list in
`__DIFF_ARGS__`, which excludes generated files.

To read one file on its own, run `git diff __RANGE__ -- <path>`. Do not add a path to the
list in `__DIFF_ARGS__`: it already holds a pathspec matching everything, git takes the
union of the two, and you would get the whole diff back believing you had asked for one
file.
