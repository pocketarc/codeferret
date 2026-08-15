Review the diff, not the repository. A scan of the whole schema spends the run's budget on
code this change did not touch, so open only the tables, indexes and migrations that a
statement in the diff depends on.

Where a statement in the diff depends on a table, an index or a migration outside it, read
that file to decide the finding, and anchor it to the line in that file, even when the diff
does not touch it. The fix for a sequential scan or a missing composite index is usually in
a migration, and an author sent to the query instead has to find that for themselves.

The skill is wrong in the places below. Correcting them here rather than in the vendored file
keeps that file to the rewrites `scripts/rewrite-markdown.ts` reproduces at vendor time, so a
re-vendor at a new PROVENANCE.tsv pin cannot revert a correction.

Its "Overuse of DISTINCT" example replaces `SELECT DISTINCT u.name` with the same query under
`GROUP BY u.name`, presented as a fix for the join. It is not: the grouping deduplicates the
same multiplied rows at the same cost, and the join still produces one row per order. For
"users with at least one order" the fix is a semi-join, which stops at the first match:
`SELECT DISTINCT u.name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id =
u.id)`. Recommend that shape, not the `GROUP BY`. Keep the `DISTINCT`: the win comes from the
semi-join, which leaves at most one row per user instead of one per order, and `u.name` is
not unique, so dropping it turns two users both called Alice into two rows where the original
returned one. Dropping `DISTINCT` is safe only once the projection carries a key.

Its N+1 fix is unsound for a second reason and it is the advice most likely to reach an
author. The "GOOD" replacement for a per-user query loop is `SELECT u.*, o.* FROM users u
LEFT JOIN orders o ON u.id = o.user_id;`, which has no `WHERE` and no `LIMIT`, so it reads
every user and every order to answer a question about a bounded page of users, and it repeats
each user's row once per matching order. It is also `SELECT *` on `users`, the table the
skill itself uses to illustrate sensitive columns. Recommend a batched fetch on the child
table keyed by the parent ids already in hand, with the columns named: `SELECT o.user_id,
o.id, o.total, o.order_date FROM orders o WHERE o.user_id = ANY($1)`.

Its "SECURE" examples select `*` from `users`, which is the table the same skill uses to
illustrate sensitive columns, and which appears as a defect in its own Data Protection list
and in its checklist. The parameterisation those examples demonstrate is right and the
projection beside it is not. The replacement under "Function Misuse in WHERE Clauses" keeps
`SELECT *` on `orders` in the same way: the range condition it teaches is right and the
projection carried over from the bad example is not. So do not read a green tick as
permission for the projection it carries: name the columns, and raise `SELECT *` in the diff
on the skill's own rule.

Its N+1 example is the one most likely to reach an author, and its replacement is worse than
the loop it replaces. The skill offers `SELECT u.*, o.* FROM users u LEFT JOIN orders o ON
u.id = o.user_id` as the fix for a per-user query loop. There is no `WHERE` and no `LIMIT`,
so it reads every user and every order to answer a question that was about one page of users,
and `u.*` repeats once per matching order, so each user is transferred as many times as they
have orders. The projection is also the `SELECT *` the same skill lists as a defect. The fix
for an N+1 is one query over the ids the caller already holds, projecting named columns:
`SELECT o.user_id, o.id, o.total FROM orders o WHERE o.user_id = ANY($1)`, grouped in the
application. Recommend that shape, and raise the skill's own example if it appears in a diff.

Its Issue Template, and the output format, scores and priority actions around it, are
upstream's own reporting shape, and none of it applies: your output is the JSON schema in the
brief above and nothing else.

That template is the one problem here not answered in prose. It nested three-backtick blocks
inside a three-backtick block, so the outer delimiter in the vendored file was raised to four
backticks by hand, which is what `scripts/prepare-skill.ts` describes in its header and what
`checkSkillFences` fails the repository over. A fence left open swallows the rest of the
file, and no wording here could reach that far, so it could not be a correction of the kind
above.

Where you have nothing to report, say in `notes` which surfaces you ruled out and how:
literal SQL in strings and fenced blocks, ORM and query-builder calls, migration and schema
files, stored procedures and views. A diff whose data access is all ORM holds no literal
SQL at all, so a grep for `SELECT` returning nothing is not on its own an answer.
