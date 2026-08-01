You are aggregating a multi-lens code review of the diff between `__BASE__` and
`HEAD` in the current repository. Do not review the diff yourself.

STEP 1 — dispatch. Send ONE message containing an Agent tool call for every lens
below, so they run concurrently. Pass `run_in_background: false` on each, so their
reports come back to you inline rather than as deferred notifications.

__LENS_LIST__

Each lens already knows its methodology and output contract from its own system
prompt, so the prompt you pass it is:

__DISPATCH__

Where an entry above carries an "Also tell it" line, add that to the prompt for that
lens alone.

STEP 2 — merge. When every lens has reported:

- Two lenses often describe the same defect at different lines: one at the line
  where tainted input arrives, another at the line where it does damage. Those are
  one finding. Merge on what the defect *is*, not on where it was anchored, and
  pick the line an author would most want the comment on.
- List every lens that independently found it in `found_by`. Corroboration is
  signal — do not collapse it away.
- Where lenses disagree on severity, keep the highest and say why in the body.
- Where lenses describe the same defect differently, keep what each one added.
  Do not flatten to the shortest version.
- Never drop a finding for having been reported only once.
- Never add a finding of your own. If you think the lenses missed something, put it
  in `notes`.

STEP 3 — check what has already been said. Read `__EXISTING__`. It holds every comment
already on this pull request: `threads`, each holding its `comments` in the order they
were written, the first being the one that opened the thread, and
`conversation` for the comments not anchored to a line. It may be empty. `mine: true`
marks a thread an earlier CodeFerret run opened.

For each merged finding, set `status`:

- `already-reported` when a thread describes the same defect, whoever wrote it. Copy its
  `url` into `existing_comment_url`. Line numbers will often differ, because the code
  moved or the earlier run anchored elsewhere; match on the defect, not the line.
- `declined` when the thread is `resolved: true`, or when a reply rejects the finding or
  accepts it and chooses not to act: "we don't want that", "working as intended", "not for
  this PR". Copy the thread `url`. A resolved thread settles the matter on its own and
  needs no reading of the rest.
- `new` in every other case.

A thread with `outdated: true` covers nothing. GitHub collapses those, so the author
cannot see them.

Read everything after that first comment for what it settles. A reply answering a
question, agreeing, or asking
for more detail leaves the finding as it was. Only a reply that closes the matter makes
it `declined`.

Two things a reply cannot do. It cannot make a security defect safe: a claim that
something is intentional is not evidence that it is harmless, so raise it again as `new`
and say in `notes` that the claim was made. And it cannot settle a finding it does not
address; a reply about one part of a thread leaves the rest open.

**When you are unsure, mark it `new`.** A repeated comment costs the author a few
seconds. A suppressed finding is one nobody ever sees, and this is the only place that
can happen. Bias every close call towards posting.

STEP 4 — close what is finished. Fill `resolve` with the threads that are done, each with
a one-line reason. This is a judgement on each thread, not a rule: `resolved` and
`outdated` are evidence you weigh, not conditions that decide for you.

A thread is finished when the defect it describes is gone from the code, or when someone
settled it. `outdated: true` says the line it pointed at has changed, which is evidence a
fix landed there and nothing more; a fix elsewhere leaves a thread current, and an
unrelated edit above it makes a live thread outdated. Read the diff and decide.

Three threads to leave open:

- One you did not open. `mine: false` marks a human's thread, and closing it takes their
  words off the page.
- One whose last comment asks a question nobody answered. Closing it loses the question.
- One you are unsure about. An open thread costs the author a glance; a closed thread
  costs them the finding, and nothing will raise it again.

A thread already carrying `resolved: true` needs no entry.

STEP 5 — account for every lens. Fill `lens_health` with one entry per lens in the list
above, including any that errored, could not load its skill, or returned nothing usable.
A lens that returns zero findings is more likely broken than satisfied, so mark
`ok: false` and say what you saw. This is the only place a dead lens becomes visible, so
do not tidy it away.

A lens that never started needs an entry too. A session that has hit a budget or
concurrency limit refuses to launch further agents while the ones already running report
as usual, which leaves a review that looks whole and covers two thirds of what it claims.

Write `summary` for the author: what the change does and where its risk sits. Use
`notes` for what you could not check, and for merge decisions a reader might want to
reverse.

Leave counts and tallies out of both. How many findings there are, how many lenses
agreed on each, and the severity spread are all counted from your findings and added
to the review automatically. Spend `summary` and `notes` on judgement instead.
