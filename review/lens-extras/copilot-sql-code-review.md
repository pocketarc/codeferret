Review the diff, not the repository. A scan of the whole schema spends the run's budget on
code this change did not touch, so open only the tables, indexes and migrations that a
statement in the diff depends on.

Where a statement in the diff depends on a table, an index or a migration outside it, read
that file to decide the finding, and anchor it to the line in that file, even when the diff
does not touch it. The fix for a sequential scan or a missing composite index is usually in
a migration, and an author sent to the query instead has to find that for themselves.

The skill is wrong in the places below, and correcting them here rather than in the skill
keeps the vendored copy matching the commit PROVENANCE.tsv pins.

Its "Overuse of DISTINCT" example replaces `SELECT DISTINCT u.name` with the same query under
`GROUP BY u.name`, presented as a fix for the join. It is not: the grouping deduplicates the
same multiplied rows at the same cost, and the join still produces one row per order. For
"users with at least one order" the fix is a semi-join, which stops at the first match:
`SELECT u.name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)`.
Recommend that shape, not the `GROUP BY`.

Its examples under "SECURE" and "GOOD" select `*` from `users`, which is the table the same
skill uses to illustrate sensitive columns, and which appears as a defect in its own Data
Protection list and in its checklist. The parameterisation those examples demonstrate is
right and the projection beside it is not, so do not read a green tick there as permission:
name the columns, and raise `SELECT *` in the diff on the skill's own rule.

Its Issue Template nests three-backtick blocks inside a three-backtick block, which leaves a
fence open from there to the end of the file. Everything after it (the output format, the
scores, the priority actions) is upstream's own reporting shape, and none of it applies:
your output is the JSON schema in the brief above and nothing else.

Where you have nothing to report, say in `notes` which surfaces you ruled out and how:
literal SQL in strings and fenced blocks, ORM and query-builder calls, migration and schema
files, stored procedures and views. A diff whose data access is all ORM holds no literal
SQL at all, so a grep for `SELECT` returning nothing is not on its own an answer.
