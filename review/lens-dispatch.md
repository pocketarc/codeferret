Review this repository's diff against `__BASE__`:

    bash __DIFF_SCRIPT__
    git log __BASE__..__HEAD__ --oneline

The first prints the diff under review. Its arguments are the NUL-separated list in
`__DIFF_ARGS__`, which excludes generated files. Reuse that list with a path added to
diff one path on its own.
