Review this repository's diff against `__BASE__`:

    bash __DIFF_SCRIPT__
    git log __BASE__..__HEAD__ --oneline

The first prints the diff under review. The arguments it runs with sit beside it in
`diff-args`, if you want the pathspec to narrow the diff to one path.
