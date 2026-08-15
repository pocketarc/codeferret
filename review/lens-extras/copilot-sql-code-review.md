---
standing-detail: >-
  No database was connected, so execution plans, index usage, redundant or fragmented
  indexes and query cost under load were not measured. Only the SQL in the diff and the
  schema and migration files it depends on were read.
---

Review the diff, not the repository. A scan of the whole schema spends the run's budget on
code this change did not touch, so open only the tables, indexes and migrations that a
statement in the diff depends on.

Where a statement in the diff depends on a table, an index or a migration outside it, read
that file to decide the finding, and anchor it to the line in that file, even when the diff
does not touch it. The fix for a sequential scan or a missing composite index is usually in
a migration, and an author sent to the query instead has to find that for themselves.

The skill is wrong in the places below.

Its first performance example, under "Query Structure Analysis", is the one an author meets
first, and its two queries do not return the same rows. The BAD query is
`SELECT DISTINCT u.*` over a three-table join; the GOOD one drops the `DISTINCT`, so a user
with twelve matching orders comes back twelve times. Naming `u.id` in the projection does not
fix that: it only stops two different users collapsing into one. The `products` join
disappears as well, and in the BAD query that join filters: an order whose `product_id`
matches no row in `products` is excluded there and included here. Recommend the shape that
preserves the result set, which is a semi-join carrying the same date range: `SELECT u.id,
u.name, u.email FROM users u WHERE EXISTS (SELECT 1 FROM orders o JOIN products p ON p.id =
o.product_id WHERE o.user_id = u.id AND o.order_date >= '2024-01-01' AND o.order_date <
'2025-01-01')`. Bare date strings rather than the `DATE '2024-01-01'` typed literal, which
SQL Server has no syntax for. The range condition on `order_date` in place of
`YEAR(o.order_date)` is the part of the skill's rewrite that is right, and it is the part
worth teaching.

Its "Overuse of DISTINCT" example replaces `SELECT DISTINCT u.name` with the same query under
`GROUP BY u.name`, presented as a fix for the join. It is not: the grouping deduplicates the
same multiplied rows at the same cost, and the join still produces one row per order. For
"users with at least one order" the fix is a semi-join, which stops at the first match:
`SELECT DISTINCT u.name FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id =
u.id)`. Recommend that shape, not the `GROUP BY`. Keep the `DISTINCT`: the win comes from the
semi-join, which leaves at most one row per user instead of one per order, and `u.name` is
not unique, so dropping it turns two users both called Alice into two rows where the original
returned one. Dropping `DISTINCT` is safe only once the projection carries a key.

Its N+1 example is the one most likely to reach an author, and its replacement is worse than
the loop it replaces. The skill offers `SELECT u.*, o.* FROM users u LEFT JOIN orders o ON
u.id = o.user_id` as the fix for a per-user query loop. There is no `WHERE` and no `LIMIT`,
so it reads every user and every order to answer a question that was about one page of users,
and `u.*` repeats once per matching order, so each user is transferred as many times as they
have orders. The projection is also the `SELECT *` the same skill lists as a defect of its
own. The fix for an N+1 is one batched query over the ids
the caller already holds, projecting named columns: `SELECT o.user_id, o.id, o.total,
o.order_date FROM orders o WHERE o.user_id = ANY($1)`, grouped in the application. Recommend
that shape, and raise the skill's own example if it appears in a diff.

Its "SECURE" examples are wrong twice over, and neither half is what an application author
needs. The projection is `SELECT *` from `users`, which is the table the same skill uses to
illustrate sensitive columns, and which appears as a defect in its own Data Protection list
and in its checklist. And the parameterisation is `PREPARE stmt FROM '...'` with a `?`
placeholder and `EXECUTE stmt USING @user_id`, labelled PostgreSQL and MySQL. That syntax is
MySQL's alone; PostgreSQL spells it `PREPARE stmt (int) AS SELECT id, email FROM users WHERE
id = $1;` and then `EXECUTE stmt(42);`. Worse, a server-side prepare driven by a session
variable settles nothing about injection, because nothing there says how `@user_id` came to
hold the untrusted value: an application that built `SET @user_id = ...` by concatenation is
still injectable. What to recommend to an author is a value bound through the driver
alongside the statement text (`db.query('SELECT id, email FROM users WHERE id = $1',
[userId])`, and its equivalent in whatever client the diff uses), with the columns named.
The replacement under "Function Misuse in WHERE Clauses" keeps `SELECT *` on `orders` in the
same way: the range condition it teaches is right and the projection carried over from the
bad example is not. So do not read a green tick as permission for the projection it carries:
name the columns, and raise `SELECT *` in the diff on the skill's own rule.

Its "SQL Style & Formatting" example carries a green tick on a join that does not do what it
says. The GOOD query leaves `o.order_date >= '2024-01-01'` in the `WHERE` clause of a
`LEFT JOIN`. Every row the join preserved for a user with no matching order carries
`o.order_date` as `NULL`, `NULL >= '2024-01-01'` is unknown, and the row is dropped, so the
`LEFT JOIN` returns exactly what an `INNER JOIN` would and an active user with no recent order
vanishes from a result the author believes is outer. The reformatting is the part worth
teaching and the join is not. Give the two shapes instead, one per intent: move the predicate
into the join condition, `LEFT JOIN orders o ON u.id = o.user_id AND o.order_date >=
'2024-01-01'`, where users with no matching order are wanted, and write `INNER JOIN` where they
are not. Raise the pattern in a reviewed diff as well: a `LEFT JOIN` whose right-hand column is
filtered anywhere but the `ON` clause, except an `IS NULL` test, which is the anti-join. Its
"Join Optimization" checklist has "Verify appropriate join types" and no example of a wrong
join.

Its checklist line "Subqueries are optimized or converted to JOINs" holds for one case and not
the other, and the corrections above on its `DISTINCT` examples go the other way. A correlated
scalar subquery in the projection, which is what its own "Aggregate and Window Functions"
example shows, does belong as a join or an aggregate: it runs once per output row. An existence
test is the opposite case, and `EXISTS` beats a join followed by `DISTINCT` or `GROUP BY`,
because a semi-join stops at the first match instead of materialising one row per order. A
checklist is what you reach for while scanning a diff, so read that line as the first case
alone; where the two disagree, follow this file.

Its SQL Server section, under the platform-specific advice, writes
`CREATE COLUMNSTORE INDEX idx_sales_cs ON sales;`, which does not parse in T-SQL. Omitting
`CLUSTERED` makes the index nonclustered, and a nonclustered columnstore index takes a column
list. The two valid spellings are `CREATE CLUSTERED COLUMNSTORE INDEX idx_sales_cs ON sales;`,
which takes no column list and converts the whole rowstore table, and
`CREATE NONCLUSTERED COLUMNSTORE INDEX idx_sales_cs ON sales (order_date, product_id, total);`,
which needs one. They are not interchangeable, and the comment above it ("Columnstore indexes
for analytics") means the clustered form. The statement sits under a heading the skill presents
as best practice with no cross beside it, so recommend the clustered form and never quote the
statement as written: an author pastes it into a migration and gets a syntax error.

Its Issue Template, and the output format, scores and priority actions around it, are
upstream's own reporting shape, and none of it applies: your output is the JSON schema in the
brief above and nothing else.

Where you have nothing to report, say in `notes` which surfaces you ruled out and how:
literal SQL in strings and fenced blocks, ORM and query-builder calls, migration and schema
files, stored procedures and views. A diff whose data access is all ORM holds no literal
SQL at all, so a grep for `SELECT` returning nothing is not on its own an answer.
