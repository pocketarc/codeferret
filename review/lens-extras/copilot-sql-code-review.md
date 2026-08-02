Your target is the diff in your instruction, and only the diff. A scan of the whole schema
spends the run's budget on code this change did not touch.

Where you have nothing to report, "no SQL, no schema and no database access anywhere in the
diff, by grep" is the shape of answer to put in `notes`.

Where a statement in the diff depends on a table, an index or a migration outside it, read
that file to decide the finding, and anchor it to the line in that file, even when the diff
does not touch it. The fix for a sequential scan or a missing composite index is usually in
a migration, and an author sent to the query instead has to find that for themselves.
