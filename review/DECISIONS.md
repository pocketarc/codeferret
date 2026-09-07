# Why CodeFerret is built this way

Each decision below came from a failed run. [`README.md`](README.md) beside this file is the
operational half: the shape of a run, how to add a lens, how to run one by hand, what each
file is for, and how to release.

## Every lens puts its findings in the structured output

If a skill defines its own output format, the subagent follows that format instead,
produces prose, and then has nothing left for the schema. One skill did this, and its
lens returned zero findings after a complete, correct review. The analysis existed and
was discarded. Without that instruction, the failure is silent and looks like a clean
pass.

## The lens's prompt states the base ref

For some skills, the subagent asks the user which commit to diff against. Nothing can
answer in a headless run, so the subagent stalls. `lens-dispatch.md` names the ref
itself, and `lens-brief.md` states both facts: the ref is decided, and there is nobody
to ask.

## Only the orchestrator's output is enforced

Subagents do not inherit `--json-schema`. That is fine, because a model reads their
output and handles drift. A script parses the orchestrator's output, so that output is
validated.

## The orchestrator merges the findings

Two lenses routinely report the same defect at different lines, one at the line where
tainted input arrives, one at the line where the damage happens. If you deduplicate by
file and line, you miss those. If you widen the tolerance, you merge genuinely separate
findings. Whether two findings are the same defect is a question about meaning, so a
model answers it.

## The orchestrator also decides what has been said before

Every push re-runs the whole review, so without this the run after the second push raises
the same 37 findings again and the pull request becomes unreadable. Matching a new finding
against an earlier one is the same question as merging two lenses' findings: the line has
often moved, and the words are rewritten every run. So the orchestrator marks each finding
`new`, `already-reported`, or `declined`, and `post-review.ts` posts only the new ones.

A suppression does not rest on the orchestrator's word alone. `vetSuppression` reads what
each one cites back out of `existing.json` or `previous.json`, and reopens whatever those
files do not bear out.

A finding may be suppressed after a decline from an `OWNER` or `COLLABORATOR`. For a decline from
a `MEMBER`, that member's fetched repository permission must be `admin`, `maintain`, or `push`.
Without an authorized decline, a finding may be suppressed through thread resolution only if the
finding is not printed in full. The `isPrinted` function determines whether a finding is printed
in full.

The bar is not the same value on both sides. `post-review.ts` hands the body the
`print-threshold` input and hands `vetSuppression` whichever of that input and the
`REVIEW_THRESHOLD` default lists more findings. Each on its own failed in a direction. The
input alone let a consumer who raised it widen the suppression bar with it: at
`print-threshold: high`, every medium finding became dismissable by the author closing their
own thread. The default alone left a `low` finding the comment printed in full open to a closed
thread at `print-threshold: low`. The wider of the two keeps both properties: raising the input
shortens the comment and never widens what a closed thread may settle, and lowering it never
leaves a finding the comment prints in full unprotected.

Replying to a closed thread takes no more than commenting and does not reopen it, so a reply
there settles the file its thread is anchored to and no other.

An `already-reported` finding is held to less, because it stays a finding in the file and
loses only its paragraph. Anyone's comment settles it. What it still needs is that the
comment exists on this pull request and is about the same file.

Most of them cite no comment at all. Under STEP 3 the orchestrator takes the status from
`previous.json` and names a url only where the entry carries one, so the ordinary
`already-reported` finding arrives with nothing named. For a while that was the one status
the orchestrator decided and nothing re-decided. It is now held to the same bar against
`previous.json`: the last review has to have raised something in the finding's file.

The bar is the file, even though the title is what the orchestrator matches on. It is told
to match the defect rather than the prose, and the lenses word the same defect differently
every run, so an exact title comparison reopened all seven suppressions of the run it was
measured against. The file is what both sides can agree on.

Every bar goes through the same file test. A reply on a thread anchored to the finding's file
counts on its own; anything else, a conversation comment included, has to name the path, or
a basename of four characters or more with nothing but punctuation or space either side.
Without that test, a maintainer who comments "LGTM, merging" settles every finding on the
pull request. What is left is that a maintainer settling one finding in a file settles every
finding this run made in that file, which is the direction to be wrong in.

Neither file is taken as the orchestrator left it. The orchestrator has `Bash` under
`bypassPermissions`, so a file it was handed could have been written by the session it is
evidence about.

A run keeps two directories for that reason. `session/` holds the files the session opens
while it runs (`diff-args`, `diff.sh`, `existing.json` and `previous.json`), and every path in
a prompt is one of those. `build/` holds the run's own record, which no prompt names and which
everything downstream reads. Each file under `session/` is a copy, so a session that rewrote
one rewrote what it reads itself, and `run.sh` copies nothing back. It does compare them, and
what it finds goes into the review, because nothing else in a run would show a lens rewriting
the diff the others read.

The split is not a boundary. `--plugin-dir` is handed the directory both of these sit under,
and a lens with `Bash` runs as this user, so `build/` is one path segment from a path the
prompt names. Everything below is what stands in place of a boundary there.

The broadest of them is a sweep. Once the session has exited, `guardBuildDir` in
`finalise.ts` removes everything directly under `build/` that is not a plain file, and
`finalise.ts` then fills every file a run's numbers live in with the values `UNREPORTED`
holds, which sits in `run-files.ts` with the names it is keyed by, and which are the ones
`extract-findings.ts` writes for a session that reported none. The sweep covers the directory rather than a list of names, because the list it
replaced named `run.json` and `lens-list.txt` and left `cost-usd`, `output-tokens`,
`duration-ms`, `findings-count` and `permission-denials` unguarded. A symbolic link at any
of those is followed by whatever reads it next: `emit_output_file` cats it into
`$GITHUB_OUTPUT`, and `upload-artifact` publishes its target for as long as the artifact is
kept. Writing the values unconditionally closes the same gap from the other side,
because a run whose log the sweep removed used to leave whatever was already under those
names, and the job summary, the action's outputs and the artifact then carried numbers with
nothing behind them. The directory is flat by construction, so whoever writes the first
subdirectory into it has to decide there what happens to it.

Removing the log is the same move against the other end of the run, and `settle` in
`finalise.ts` is what it costs. Where there is no `run.json` after the session, `run.sh` runs
no extraction, the shape check has no findings file to read, and `settle` writes no
`findings-checked`, so nothing is posted. Such a run used to end on whatever the session
exited with, which after a clean exit is 0, so a maintainer read a green job beside a pull
request nobody had reviewed. It ends red now, with the reason on stderr.

All of this was shell inside `run.sh`, and `bun test` covers no shell, so no branch of it was
ever exercised. `finalise.test.ts` is what it moved for.

`existing.json` and `previous.json` get more than a comparison: `run.sh` replaces the build
directory's copies with their empty forms once the session has exited, and a step that holds a
credential of its own fetches them again. The action's posting step fetches both, and that
fetch also picks up whatever was said during the twenty minutes the review took.
`local-post.sh` and `local-print.sh` fetch only `existing.json`, because `ownWorkflow` in
`fetch-previous.ts` answers null where nothing names a workflow and every artifact is then
refused, so the second call would spend requests to write the empty form that is already
there.

Leaving `previous.json` off that list opened a hole.
`vetSuppression` reads it through `filesRaisedBefore`, and the set that comes back is the
whole of what settles an `already-reported` finding citing no comment, which `orchestrator.md`
makes the ordinary case. A session writing `{"findings": [{"file": "..."}]}` into the build
copy settled every finding below the threshold in the files it named, and `markPosted`
writes the vetted status into the artifact, so that suppression carried into every later run
for as long as the pull request lived.

`diff-args` and `lenses.txt` cannot be fetched again: `reviewed-commit.ts` takes the commit
the review is recorded against out of the first, and `readDispatched` reads the second for
which lenses ran. For those two `run.sh` takes a `shasum` digest before the session and
holds it in its own shell variables. A file of digests would be a file the session can rewrite
alongside what it describes, and comparing the two copies has the same flaw: the same session
writes both, so identical replacements pass `cmp` in silence. What a lens cannot reach without
ptrace on an ancestor is the memory of the process that started the agent. Where there is no
`shasum`, the run says so, because a reader could not tell two empty comparisons from nothing
having changed.

Both comparisons write the names they found into `build/session-changed.txt`, and the review
body turns that into a coverage warning beside the one for a lens that reported nothing about
itself. Stderr on its own was not enough, because the reader these caveats are for never opens
a job log: a session that rewrote `lenses.txt` to name only the lenses it accounted for would
produce a review that reads as complete, with the discrepancy recorded where nobody looks.

What the run does not do is refuse to post. Clearing `findings-checked` was the other way to
act on this, and it fails in the wrong direction twice over: it leaves a twenty-minute review
saying nothing at all, which is the failure every coverage warning exists to prevent, and it
hands a session that wants its findings buried a one-line way to do it. Those findings are
still worth posting. What a reader must not be left with is a review that reads as complete
when the lens list behind it is the session's own answer.

The orchestrator matches against two files. `build/previous.json` holds what the last run
reported, and that is where a repeat is caught. `build/existing.json` holds the discussion on
the pull request, every author included. A defect a human already raised does not need
raising again, and a reply is where the answer to a finding lives: "we don't want that" makes
a finding `declined`, which the review reports separately from the ones merely said before.
Two things a reply cannot do, both in `orchestrator.md`: it cannot make a security defect
safe by asserting the code is intentional, and it cannot settle a finding it does not
address.

What keeps that safe is where the orchestrator is told to err. It marks a finding `new`
whenever it is unsure, because a repeated comment costs the author seconds while a suppressed
finding is one nobody ever sees.

An outdated comment does not count as covering anything. GitHub collapses a comment when
the line it referred to changes, so a defect that survived an edit still needs saying.

## The previous run's findings come out of its artifact

Nothing GitHub's comment APIs return includes a review body. `fetch-existing.ts` reads
`reviewThreads`, which is inline comments, and `issues/{n}/comments`, which is the
conversation; a review body is neither. The whole review is a body now, so without this the
run after it could see none of it. This predates the change: on the last run before it, the
cap at forty comments left 60 findings of 100 in the body alone, and every one of those was
going to be raised as new on every push for as long as the pull request stayed open.

So `fetch-previous.ts` fetches `codeferret-run` artifacts for this pull request's branch,
newest first, reads `findings.json` out of the zip, and writes the file, line, title and
status of each finding to `build/previous.json`. The bodies are left behind: matching is on
the file and the title, and pulling a previous review's prose into this run's context adds
nothing.

Every one of these has to be true of an artifact before what it holds can suppress a
finding. `previous.ts` answers each of them.

Its review has to have been posted. `post-review.ts` writes `posted` into `findings.json`
once GitHub has accepted the review, and the action uploads after that, so the record
travels inside the one file every consumer keeps. Ordinary paths reach an uploaded artifact
with no review on the pull request: `post: 'false'`, a 502 from the reviews endpoint, and a
token without `pull-requests: write`. A run killed by `cancel-in-progress` used to be
another, and the upload step's condition is `!cancelled()` so that it is not: with
`artifact-path: '.'` the build directory exists within seconds, so under `always()` every
superseded push uploaded an artifact whose review was never posted. A run that takes one of
those for a posted review marks every finding `already-reported` against comments nobody
ever saw, and writes that status into its own findings file, so the suppression lasts as
long as the pull request. That is the failure this whole path exists to avoid, caused by the
path itself. A run that ends red is a different case and still counts: `check-findings.ts`
drops what it cannot use, the review lands, and the job goes red over what was dropped. So
the newest artifact with a posted review wins, and one without is stepped over for the run
before it.

A run with nothing new to post records itself anyway, with a null url. It suppressed
everything on the strength of a review that did land, and `previousRun` opens ten artifacts
before giving up: without a record, ten quiet pushes would put that review out of reach and
the eleventh run would raise the whole review again on a pull request that was already
clean.

That review has to have been of this pull request. Artifacts are found by head branch, and
a branch name is evidence of nothing: `fix/lint` and a release branch are deleted on merge
and recreated inside the retention window, and GitHub allows one branch to head two open
pull requests against different bases. So `post-review.ts` writes the number into the
`posted` record and `previous.ts` requires it to match. A record with no number comes
from a release that wrote none, and it does not match, which costs one round of repeated
comments.

It has to have come from a run of a branch pushed here. For a `pull_request` event GitHub
runs the workflow files as the pull request has them, so a fork's copy of the workflow
runs, and whatever it uploads is stored against this repository and listed by the artifacts
endpoint. `head_branch` is a name whoever opened the pull request chose, and open branch
names are public, so matching on it is no evidence at all. What a fork run cannot produce
is a match between the producing run's `repository_id` and its `head_repository_id`, so
that is what is required.

And it has to have come from a run of this workflow. The artifacts endpoint lists every
`codeferret-run` artifact in the repository whatever produced it, so without this check
anyone who can push a branch can add a throwaway workflow that uploads a `findings.json`
holding a `posted` record and a list of file and title pairs, let it run once, and delete
the workflow in the next push. The artifact outlives the branch for the whole retention
window, the endpoint lists it ahead of every genuine one, and the next review marks each of
those findings `already-reported`. Changing `fetch-previous.ts` would do the same thing and
be in the diff a reviewer reads; this leaves nothing behind. So `fetch-previous.ts` reads
its own run's `workflow_id` and requires the producing run to name the same one. In a
session nothing names a workflow, and then nothing counts: with none to compare against, a
genuine artifact and a forged one read alike, so `/codeferret:review` suppresses nothing and
prints findings it has shown before. That guard used to be wrapped in a test for the run id
being set, which skipped it in exactly the case it refuses.

Reading an artifact needs `actions: read`, which the shipped workflow grants and a consumer
can decline. So every failure is a line on stderr and a file holding no findings. No
permission, no artifact, a retention window that has closed, and a first run all mean the
same thing: every finding is new. That is what happened before this existed, so a repository
that grants nothing is exactly where it was. `unzip.ts` reads the archive itself rather than
shelling out to `unzip`. That binary is not on every runner, and it is rarely in the
container a `command-prefix` points at, where a missing binary would look identical to a
pull request with no previous run. `unzip.ts` also bounds what one entry may inflate to,
because deflate reaches past 1000:1 and an out-of-memory kill is the one failure this path
is not allowed to have.

## Excluded paths are excluded in git

The `exclude-paths` input becomes a pathspec on the diff command each lens is given, so
a lockfile is not in the diff at all. `build-prompts.sh` writes that pathspec to
`build/diff-args`, and everything downstream that needs it reads that file back. Two
constructions of the same pathspec drifted once, and the anchor map `post-review.ts` built
then covered files no lens had read.

## Text for one lens goes in that lens's own prompt

Text meant for one lens reaches it through `review/lens-extras/<lens>.md`, which
`scripts/build-lens-agents.ts` renders into that one agent's system prompt. Handing it to
every lens pushes them all toward the same generalist read, and the differentiated findings
come from lenses staying inside their own domain: on a ten-lens run the RSC boundary
violation, the missing index, and the keyboard-access failure were each found by exactly
one lens.

Routing it through the orchestrator instead is worse than either. Put that instruction in
the orchestrator's prompt and the routing becomes a judgement the orchestrator remakes every
run, with nothing downstream to show when the text went to the wrong lens or to all of them.

What the directory holds is what a vendored skill assumes and this run cannot provide:
that there is no browser and no running site for `copilot-web-design-reviewer`, that a
criterion needing a rendered page is out of reach for the accessibility lens, and that the
SQL lens has no database behind it, so its offer of a whole-project pass does not apply and
neither do the sections of its skill that ask for a plan or an index-usage statistic.

It is also where a correction to a vendored skill goes. Editing the skill itself would put
the correction among the rewrites `scripts/rewrite-markdown.ts` reproduces at vendor time, so
a re-vendor at a new `PROVENANCE.tsv` pin would revert it with nothing saying so. The one
class of problem an extras file cannot answer is a broken markdown fence: the SQL skill's
Issue Template nests three-backtick blocks inside a three-backtick block, so the outer
delimiter was raised to four by hand, which is what `prepare-skill.ts` describes in its header
and what `checkSkillFences` fails the repository over. Everything after an open fence is
inside the block, and no wording in a prompt reaches that far.

Keep those two facts here rather than in the extras file. That file is read by an agent, and
usually by one pointed at somebody else's repository, where `rewrite-markdown.ts`,
`PROVENANCE.tsv`, `prepare-skill.ts` and `checkSkillFences` are all names of things that are
not there. A lens sent after a file it cannot find goes hunting and reports the hunt, which is
why `stripDeadLinks` exists at all.

Read a change to one of these files yourself, against the skill it overrides. When
CodeFerret reviews this repository, the file under review is the instruction that the lens
reviewing it ran under, and that lens can only notice a gap in the file by reading past its
own prompt. `validate-repo.ts` catches a file that names no lens, and nothing catches
one whose instructions no longer match the skill it overrides.

A second directory used to hold per-lens text that depended on the run, spliced into the
lens list and handed on by the orchestrator. It is gone, for the reason the paragraph above
gives: it made the routing a judgement remade every run. Nothing needed it. A lens that
wants a path this run wrote can take it from the directory holding the `diff-args` file its
dispatch already names.

## A finding shows the claim and nothing else

No tier, no lens attribution, no count of how many lenses agreed. `findings.json` carries all
of it, and the tier orders the findings and decides which ones the comment prints in full, but
none of it is printed beside a finding.

A single word chosen by a model was the first attempt at this, and it could not be trusted.
`severity` was an enum of six values with no `description` in `merged-schema.json` while every
sibling field had one, and what a lens read about it amounted to "severity has a field of its
own". So each lens graded against whatever those words meant to it, on a question the lens is
in no position to answer anyway: a missing index is critical on a large table and irrelevant
on a small one, and nothing in the diff says which. Printing that guess would have turned one
lens's ignorance into the reader's permission to skip, and filtering on it would have been
worse. A label too unreliable to show is far too unreliable to hide a finding with.

What replaced it is a different question. The orchestrator grades nothing. It answers `risk`,
a set of bounded questions about the defect in front of it, and `scripts/build-risk-schema.ts`
writes each question and the meaning of each of its answers into `merged-schema.json` from the
`AXES` table, so the definition a model reads is the definition the scorer holds. Whether the
data at risk is reportable, whether the damage can be undone, what someone must already hold to
trigger it: a reader of a diff can answer those from the diff. `review/risk.ts` then weighs the
answers into a score and bands it into a tier, as a pure function over an object that
`risk.test.ts` pins. So the judgement moved out of the model's vocabulary and into a table
anyone can read, argue with, and correct for every finding at once. It has already been
corrected twice on evidence: an unanswered axis used to share its weight among the axes that did
answer, which gave a stale comment answering two axes the same weight as a missing index
answering six, and the two reach axes used to multiply unfloored, which took a hardcoded
credential from a base of 0.82 to a score of 20. Neither mistake is one an adjective could have
exposed.

The `print-threshold` input then decides which findings the comment prints in full, and
`isPrinted` compares each finding's tier against it where the run has an artifact to leave the
rest to. The heading names the bar rather than the tiers that cleared it, and the body carries
it only on an artifact run, because `bullet` prints no tier and the heading is the reader's only
account of what was left out; a heading built from the findings present would rename the
section every run, and a reader could take it as a promise that nothing lower was found. Where
the band edges belong is still open. The bands themselves rest on a blind rating of the fixture
branch, recorded in the docstring on `REVIEW_THRESHOLD`, which is what put the `medium` default
where it is; the `TIERS` docstring has what that rating leaves unsettled.

Nobody overlooked the cost. A finding below the threshold is in `findings.json` and nowhere a
person will look. How many there were is on the page: `listingOf` leads the section with `6 of
40 findings.` and a link to the artifact holding the rest, so a reader can tell a run that found
four things from one that found four and left thirty behind. What the line cannot say is what
those thirty were about, and whether one of them is the one that reader came to find. The trade
rests on who reads what: whoever fixes a review is an agent reading the file, which is complete, and
the comment is where a person decides whether to stop and look, which a list of every nit makes
harder. The lead is written only where there is an artifact to send a reader to; without one the
body prints every finding, so there is nothing left out to count.

A review posted from a session has no artifact, and its findings file is a path under
`.git/` on one person's machine. Nothing branches on the tier there: the body prints every
finding, and `assemble` cuts from the end and says how many did not fit. Splitting the
review between a comment and a file only works where both are reachable.

Agreement between lenses is withheld because it tracks how conspicuous a defect is, not
how much it matters. On a ten-lens run the most-corroborated finding was a cache-key nit
that six lenses spotted, while the missing index, the RSC boundary violation, and the
keyboard-access failure were each found by one. Showing "6 of 10" beside the nit tells
the reader it is the consensus priority, which is the opposite of the truth.

## The orchestrator decides which threads to close

A thread is finished when its defect has left the code or when someone settled it, and
neither is a question a rule answers. `isOutdated: true` means the anchored line changed,
which a fix landing elsewhere does not produce and an unrelated edit above does, so the
orchestrator weighs it against the diff. It leaves open any thread a human opened, any
whose last comment asks an unanswered question, and any it is unsure about. Each closure
has a reason, and `review-body.ts` prints them in the review, so a wrong call is visible.

Which threads are the run's own is decided by two things together: the login the review
posts under, and a hidden marker in the comment that opened the thread. `github-actions[bot]`
is the login of every workflow posting with `github.token`, so the login alone would put
another workflow's threads on the list this run may close. The marker alone is worse: an
HTML comment renders as nothing, so anyone who can open a review thread could write it into
their own and have this run adopt the thread. Both halves are required.

Nothing writes the marker now. A body-only review creates no threads at all, so what is left
to recognise are the threads left open by the runs made while the plugin work was in
progress. A trailing `<sub>` category line counted as a second shape for a while, on the
theory that a released version had ended its inline comments that way. No version has been
released, every thread this run has seen carries the marker, and markup anyone can reproduce
proves nothing about who wrote a comment, in a test whose whole job is to be narrow. So it
went.

A resolved thread settles a finding only where the body prints no more than one line for it:
`vetSuppression` reopens `resolved: true` on anything `isPrinted` puts in the comment in full,
and holds those to the same author-association bar as a reply. Closing a thread takes
repository write or authorship of the pull request, and `resolveReviewThread` grants
neither: on a branch from an outside contributor, the only account that can close a thread
is the one whose work is under review, which is not the standing that commenting takes. What
closure settles is bound to the file the thread is anchored to, and no other.

Outside CI the review posts under a person's own account, so `resolve-none.md` is rendered in
place of `resolve-judge.md` and the orchestrator closes nothing. Each policy is its own file,
so the prompt states one policy whichever way the run goes. `RESOLVE_THREADS=1` picks
`resolve-judge.md`, and anything else picks `resolve-none.md`: `post-review.ts` tests the same
value the same way, so a caller who sets nothing, or who sets a value neither script
recognises, gets a run that asks the orchestrator for nothing it could then act on.

## The review is one comment

It used to be up to forty inline comments plus a body. That existed because a comment was
the only way to deliver a finding, and it made a forty-comment pull request out of a review
nobody had read yet. What acts on a review here is usually an agent, and what it reads is
`findings.json` in the run's artifact, which is complete: every finding with its body, the
answers it was rated on and the lenses that found it, the suppressed ones included. So the
comment is for the person deciding whether to stop, and the file is for whoever fixes it.

That leaves a body holding the summary, the counts, `lens_health`, and the findings the
paragraph above says belong in it. `body-budget.ts` bounds it: the short
sections that make the review honest are assembled first, the listing takes what is left,
and it drops whole findings rather than being cut at a character offset, which would land
inside a `<details>` or a fenced block and leave GitHub rendering the wreckage.

Not from the end, though the order it drops in reads that way most of the time. `cutToFit`
skips a finding too long for what is left and carries on, rather than stopping there, because
`partition` orders worst first and one verbose finding at the top would otherwise empty the
section under it. So what goes is whatever does not fit, and a finding printed below a dropped
one is the ordinary case rather than a fault. The omission line says when the dropped set
outranks something printed, which is the part a reader cannot infer from the page.

A good deal went with the inline comments. Whether a line sat inside a diff hunk was checked
here rather than taken from the lens's own `in_diff`, which was wrong on every run; the
reviews API is atomic, so one bad anchor returned 422 and created no comments at all.
Findings outside the diff went into the body under a heading of their own. A cap at forty
kept the batch under a secondary rate limit that had refused 95 comments twice, sixty
seconds apart, and every one of them was lost.
None of it applies to a body with no comments in it. Whoever adds the first inline comment
back has to bring all of it with them.

## `lens_health` covers every lens dispatched

A lens that spends money and returns nothing exits successfully and looks identical to a
clean run. That is survivable at three lenses and invisible at twenty.

Zero findings is treated as a failure, with one exception: a lens that returns nothing
and names a checkable reason for it, which the orchestrator reads against the diff before
accepting. The exception exists because the earlier rule left correctly-empty domain
lenses filed as broken. Half the default set is domain lenses, and a tooling diff leaves
the SQL, Next.js, accessibility and web design ones with nothing in their domain; three
warnings on a healthy run teach a reader to skip the line, and the line is the only place
a lens that really did die shows up. A lens that returns nothing and says nothing is still
a failure.

A review is posted even when nothing survives. Zero findings and a failed lens is the shape
of a review that never happened, and posting nothing leaves a pull request looking clean.
The test is the body rather than the failure: `composeReview` returns `warned` for every
condition under which the body says something about its own coverage, and a run with nothing
new posts whenever that is set. A lens missing from `lens_health` and a `lens_health` that is
absent altogether both count, and the earlier condition of a failed lens alone was true for
neither.

The condition and the sentence are one entry. `COVERAGE_NOTICES` in `caveats.ts` is a `Record`
over the notice names, each holding when the run raises it and what it then says, and the names
come from the ordered list above it, so a notice has a place on the page before it compiles.
`warned` counts what that record raised, the head prints it, and `print-findings.ts` prints the
same sentences to a terminal. `POSTING_NOTICES` in `review-body.ts` is the same shape for the
one thing the body says about its own posting.

`warned` counts any notice a run raised, whatever `level` renders it as. Filtering to warnings
read as the tidier rule and was the same bug in a new place: `limited` is a note, so a first
review that found no critical defect posted nothing and the reader took the unchecked criteria
for checked.

That has a consequence, weighed on 2026-09-05 and accepted. The shipped lens set always raises
`limited` — three of its lenses have no browser and say so — so `warned` is always true and the
branch in `post-review.ts` that posts nothing when nothing is new cannot fire. Every push to a
pull request gets a comment. The branch stays, because a lens set excluding those three reaches
it, and the repetition is the cost this repository takes elsewhere on the same trade: a repeated
comment costs less than a finding nobody sees. What would buy the quiet back is saying a
standing caveat only where no earlier review is still carrying it. Nothing here knows that
today: a review body is neither a review thread nor a conversation comment, so the comment fetch
does not return it, and the only record that one was posted is the `posted` marker in the
previous run's artifact.

Both halves were written out by hand once, and each lost one. `warned` restated the conditions
as a boolean expression and left out `limited`, the lenses `caveatOf` gives a sentence for,
which renders as a `[!NOTE]` rather than a `[!WARNING]`. That is the standing sentence
`STANDING_DETAIL` exists to carry, so a first run over markup that produced no critical defect
went green with nothing posted, and the reader took contrast, focus order, target size and
reflow for checked. The rendering then kept its own list of `if`s, and the thread warning there
was keyed off a permission denial rather than off a thread being left open, so one that failed
on a stale node id went to stderr and nowhere a reader of the pull request would find it.

## The reviewed tree does not configure the session

`--strict-mcp-config` with no config file disables MCP servers: they added roughly 28k
tokens per session, a diff review uses nothing they provide, and a `.mcp.json` on the
reviewed branch would otherwise be read.

`--setting-sources user` closes the two channels beside it. The session starts inside the
reviewed working tree, so without the flag Claude Code loads that branch's `CLAUDE.md` as
instruction into the process that decides which findings are `new`, and its
`.claude/settings.json` as settings. Both were measured on 2.1.220 against a real
dispatch: the model reads the memory file, and a `SessionStart` hook declared in project
settings runs even under `--permission-mode bypassPermissions`. That hook is a shell command
whoever pushed that branch wrote. Plugins passed with `--plugin-dir` still load, so the lens
agents are unaffected, and text meant for one of them reaches it through
`review/lens-extras/` instead.

## Bun runs whatever a `bunfig.toml` in the reviewed tree names

Bun reads `bunfig.toml` from its working directory, and `preload` in that file names a
script bun runs before the one on the command line. Bun looks in the working directory and
nowhere else: the script's own path does not matter, and bun does not walk up from the
directory it starts in. `--config=<path>` replaces that lookup outright, and the local file
is then ignored. Measured on bun 1.3.5; `-c` is the same flag and takes its value with an
`=`, so `-c file` is read as an entry point.

A review is a job holding `CLAUDE_CODE_OAUTH_TOKEN` and a `pull-requests: write` token, and
a run is several `bun` invocations, two of which are handed that token. So one `bunfig.toml`
on a branch is enough for bun to run the script it names inside that job, before a lens is
dispatched, with no model in the loop and nothing to inject. Under `/codeferret:review` bun
runs that script on the developer's machine, whatever the permission mode, because the only
command Claude Code is asked to approve is `local-run.sh`.

The working directory was the first answer and it is not enough on its own. It closes the
branch's own file: `run.sh` runs from `$BUILD`, `build-prompts.sh` and `local-post.sh` run
theirs from there in a subshell, and the action's `bun` steps set `working-directory`. But
every directory the session is still allowed to run from is one it can write. The
orchestrator has `Bash` under `bypassPermissions` and its prompt names `$BUILD` absolutely,
so `touch $BUILD/bunfig.toml` moves the same execution one step along. Under
`command-prefix` the working directory is the prefix's own, which the action asks to be the
repository root, so there it closed nothing at all.

So every `bun` a review starts takes `--config=/dev/null` as well. That replaces the
lookup wherever the process happens to be standing, and `/dev/null` is the one path on a
runner whose contents nothing short of root can change. Every invocation takes it: `run.sh`,
`build-prompts.sh`, action.yml, the `local-*` scripts and `scripts/vendor-lens.sh`.
`checks/bun-config.ts` reads `review/*.sh`, `scripts/*.sh` and `action.yml` for one that does not.
Naming a narrower scope here would leave a reader believing a `scripts/*.sh` invocation goes
unchecked.

No environment variable does the same job. Measured on bun 1.3.5, `BUN_CONFIG_FILE=/dev/null
bun main.ts` ran the `preload` the working directory's `bunfig.toml` named, and
`bun --config=/dev/null main.ts` did not, so a variable set once for the whole run would
replace nothing. A guard written inside the script would run too late, because the preload
runs first.

A `cf_bun` wrapper in `lib.sh`, with the rule narrowed to "no shell may name `bun` outside
it", was weighed and refused. The live shell that names bun without running it (`command -v
bun`, `bun@$BUN_VERSION`, an `echo` about bun already being on `PATH`) still needs an
exception under that rule, entry by entry, so the wrapper moves that list rather than
deleting it. It also reaches only the shell half: a `.ts` file cannot call a shell function, so
the printed hints stay exactly as they are. What it would buy is one fewer place to forget the
flag, and the invocations where forgetting it mattered already go through `run_tool`.

The working directory still moves, because a relative path in a report or an argument
resolves against it. Only the orchestrator starts in the workspace, in a subshell of its
own, because its lenses read whatever tree their session started in. The tools take the
workspace as an argument and ask git for the top level from there.

## A lens agent ships pre-built

What changes between runs is the base ref and the pathspec, and both reach a lens
through the message the orchestrator sends: the ref as text, the pathspec as the path to
a generated `diff.sh`. What does not change (which skill to load, the output schema,
report-do-not-repair) is the agent's own system prompt, so `agents/` is rendered once by
`scripts/build-lens-agents.ts` and checked in. That split lets a session run the same
lenses the action does: Claude Code loads a plugin's agents when the session starts, and
nothing can add more halfway through.

A lens the plugin does not bundle has no agent to check in, so `build-prompts.sh` renders
one into the run's plugin with the same script, and copies the skill in beside it. It used
to dispatch the generic agent and tell the orchestrator which skill to pass on, and a lens
that never received that line returned a competent general review under its name with no
skill loaded.

The copy is what makes a workspace lens work at all. `--setting-sources user` takes a
project's own `.claude/skills/` with it, measured against a real dispatch on 2.1.220: a
session started in a directory holding one could not find it, and the same session without
the flag loaded it. Left where it lives, every workspace lens would follow its agent's own
instruction to stop and return nothing, which is the failure the paragraph above describes.

## The action assembles its plugin in `RUNNER_TEMP`

It copies in only the lenses named for that run, so an unrequested lens has no agent to
dispatch and no skill to load, which is a second lock on the `lenses` input besides the
list in the prompt. Building it outside the workspace also leaves the calling
repository's tree untouched. A session skips all of this: it has the plugin installed
already.

## The orchestrator runs in its own process

A review reads two things written by whoever opened the pull request: the diff, and
every comment on it. A Claude Code session holds an editor, a shell, and whatever its owner
has connected over MCP. Untrusted text and that set of tools in one context is the whole of
prompt injection, so `run.sh` spends a second process keeping them apart. The session reads
`findings.json` back and nothing else.

## The GitHub token never enters the step that runs the agent

`run.sh` fetches `existing.json` and `previous.json` before the session, so it needs a token
that can read the pull request. It used to take that token out of its own environment with
`unset`, which is not something `unset` can do. A process's environment block is written
once, at `execve`, and `/proc/<pid>/environ` holds that block for as long as the process
lives. A lens runs as the same user and has `Bash`.

Measured in a Linux container against the two step bodies as `action.yml` shipped them: the
agent's own environment was clean, and `tr '\0' '\n' </proc/$PPID/environ` from the agent
returned `GITHUB_TOKEN=<value>` out of `run.sh`'s, and again out of the step shell's above it.

So the value never enters that environment. A value in a step's `env:` is in the environment
of every process that step starts, so the step that execs the agent declares no
`github-token` at all. A step of its own writes it to
`$RUNNER_TEMP/codeferret.token` at mode 0600, the review step is given the path,
and `run.sh` reads the file and deletes it before the session starts. `token_file` in
`lib.sh` is the one place either path is built, and `local-run.sh` does the same with the
`gh` credential and drops the variable before it `exec`s. Over the fixed shape the same
measurement came back empty: no ancestor's environment held the token, and no file under
`RUNNER_TEMP` did either.

The second half of that measurement is a claim about every path out of `run.sh`, so every
guard on what the caller asked for sits below the block that reads and deletes the file. Two
of them did not, and each left the plaintext credential in the run directory with nothing
running that would have cleared it: under `/codeferret:review` that is a developer's own `gh`
token, staged by a script that then `exec`s, so no trap of its own survives.

`run.sh` used to refetch `existing.json` after the session as well, and the steps that post
and print do that now, `previous.json` with it. Both `bun` and the scripts under
`$GITHUB_ACTION_PATH` are files this user owns (`install: auto` installs the first with
`npm install -g`), so a session with `Bash` has the length of a review to replace either, and
any credential handed over afterwards goes to code a lens chose. Moving the fetch does not
make that untrue; it means the run authenticates once after the session rather than twice, at
a step that holds a token for its own work anyway, and `run.sh` drops the value before an
agent starts rather than holding it across the review.

What is left is worth naming. The token stays in `run.sh`'s shell memory for the two fetches,
and reading that takes ptrace on an ancestor, which is off under Yama's default scope. The
runner puts `ACTIONS_RUNTIME_TOKEN` into every step's environment itself, so it is in `/proc`
before this action runs at all and nothing here can take it out. And the posting step still
holds a token, so the routes the `run.sh` comment already names (a line appended to
`GITHUB_ENV`, or overwriting the `bun` on `PATH`) reach it as they did. What closes that one
is posting from a job that never runs the agent. A composite action has steps rather than
jobs, so the last post-session use of the credential is now in the one step a consumer could
lift out into a job of their own.

## Which permissions a lens gets is an argument

CI passes `bypassPermissions`: the runner is disposable, and a classifier that refused a
lens halfway would narrow a review that cost $36 to produce. `/codeferret:review` passes
`auto`. Under `auto`, a lens can run `git diff`, `git log` and `rg`, and the classifier
refuses the rest. That was measured on a real dispatch. Either way
`permission_denials` is counted out of the run log and reported, so a mode that starts
refusing commands a lens needs shows up as a number.

## A bundled lens's `description` is rewritten

Upstream wrote each one to win an invocation, and `writing-review`'s reads "proactively
whenever writing, reviewing, or rewriting text". That is right for a skill somebody
installed deliberately and wrong for a set that arrived inside a code review tool.
Once the plugin is installed, those descriptions put a lens in front of the model during
unrelated work. `prepare-skill.ts` replaces them all, and nothing downstream reads them,
because a lens agent is told which skill to load by name.

## A lens agent names the tools it gets

Naming them leaves out every MCP tool, which a diff review has no use for and which
`--strict-mcp-config` already removes for the action. The catch is that a name Claude
Code does not recognise is dropped in silence, and so is one that conflicts with another
name in the same list. `Grep`, `Glob`, and `TodoWrite` were all in the list and none
reached the agent: `TodoWrite` is not a name on 2.1.220, and `Grep` and `Glob` are
refused to any agent that also asks for `Bash`, which every lens needs for `git diff`.
That pair is mutually exclusive by design, and Claude Code returns the explanation to the
agent and to nobody else: "Grep is not available in this session — search file contents
with grep via the Bash tool instead." So the list has to be checked against a real
dispatch whenever it changes.
