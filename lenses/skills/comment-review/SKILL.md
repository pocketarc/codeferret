---
name: comment-review
description: Review the comments a change adds or leaves behind. Finds comments that restate the code, narrate history, or document an absence, and comments the change has made untrue. Use when reviewing a diff for whether its prose earns its place.
---

# Comment Review

Most comments are written for a reader who does not exist: someone who cannot tell what
the code does and needs the author's reasoning narrated. Review for a principal engineer
instead. They read the code, and they check history when they want a timeline.

Report a comment that should not exist, or should say less, as a finding on its line.

## Out of scope

Comments a tool reads are code, not prose. Never report these:

- Type annotations static analysis depends on: `@param`, `@return`, generics in docblocks
- Suppressions: `eslint-disable`, `biome-ignore`, `@ts-expect-error`, `@phpstan-ignore`, `noqa`
- Directives: `"use client"`, pragmas, formatter and editor controls
- Codegen banners, licence and copyright headers
- Frontmatter, and structured metadata generally

A suppression's *justification text* is prose and is in scope. The suppression is not.

## The test

For every prose comment in the diff:

> Would a principal engineer, reading this code, already understand why it is there?

Yes, and the comment should go. No, and only the part they could not infer should stay,
in as few words as it takes.

Judge it blind. Read the code with the comment covered and decide what you can work out
unaided, *then* look at what the comment claims. Reading the comment first makes almost
any comment feel necessary.

Score each claim separately. One sentence of real constraint wrapped in three of
narration is the usual shape, and the verdict is to keep the one.

## Code is never there for no reason

A competent reader assumes every construct is deliberate. A timeout implies a timing
problem, a retry implies flakiness, a null guard implies null arrives. None of that needs
saying.

```ts
// Bumped to 60s because the default 30s timed out on cold compiles.
timeout: 60_000,
```

The reader sees a raised timeout and infers a timing problem. `git log -S` gives them the
commit, the date, and the message. This is the most common form of over-commenting and is
nearly always removable. The same goes for backoff, defensive clamps, `try`/`catch` around
a known-flaky call, generous buffers, and pinned versions.

## Enforce it before explaining it

> If someone violated this, would anything fail?

If nothing would, the fix is a test or a lint rule, not a comment. An invariant worth
writing down is worth enforcing, and once enforced the comment is redundant: whoever
breaks it finds out from the failure, which can carry the reason.

"These two lists must stay in sync" is a test. "This must run before that" is often an
assertion. Reach for a comment only when mechanising would cost more than it protects,
and say so when you decide that.

## What earns its place

Knowledge the reader cannot reach from the code in front of them, where lacking it would
lead them to change the code wrongly.

- **An invariant the design rests on**, where enforcing it mechanically is impractical.
  The condition that, if it stopped holding, would make this code wrong.
- **An external fact.** A vendor quirk, an upstream bug, a spec footnote, a wire-format
  constraint. The reader cannot derive it by reading harder, because the cause is outside
  the repository.
- **A constraint that looks arbitrary.** Ordering that must hold, a call that must not be
  hoisted, two values that must agree. The tell is that the obvious tidy-up breaks it
  without failing a test.
- **A rejected alternative that looks correct**, but only when the reader would otherwise
  try it and the failure would be silent or expensive. If the wrong path fails loudly on
  the next test run, say nothing.
- **A domain rule the code cannot express.** Why invoices freeze an exchange rate on
  payment. Business truth, not mechanism.

Prefer the conditional form. Given a choice between explaining the decision and naming
the condition the decision depends on, the condition is what stops someone breaking it
later.

## What does not

- Restating the code: `// increment the counter` above `count++`.
- **Documenting an absence.** "No checkout step here because…", "we deliberately don't
  cache this". A reader is not asking why the file lacks something. This is the same
  error as narrating a change, aimed at code that was never written.
- History: "this used to be", "previously we", "now that we've added". Commit messages
  hold this.
- Reasoning a test already demonstrates. Point at the test if the link is not obvious.
- Well-known API semantics: how `useEffect` cleanup works, what `Promise.all` rejects on.
- Why this API and not the neighbouring one, when the code makes the reason evident.
- Signposting: "note that", "the important part is below", "as mentioned above".
- Justifying the obviously correct. Nobody needs persuading that input is validated.
- The same point in two files. Keep it where a reader will be standing when they need it.

## What a diff exposes that a file does not

- **Comments the change made untrue.** The code moved and the prose did not. A comment
  describing behaviour the diff has just altered is worse than no comment, because it is
  now actively misleading. Check every comment adjacent to a changed line, not only the
  comments the diff adds.
- **A comment doing a rename's work.** If the change added prose explaining what a
  variable holds, the variable is misnamed.
- **Comment volume rising faster than the code.** A hunk that is mostly prose usually
  means the code is unclear, and the finding is the code, not the comment.

## Reporting

Anchor each finding on the comment's first line. Say which of the two verdicts applies:

- **Delete.** The whole comment goes, not just its weaker sentences. Say what a reader
  infers unaided that makes it redundant.
- **Trim.** Give the replacement text. Do not soften a Delete into a Trim to keep a
  sentence you like.

For a comment the change made untrue, the finding is the inaccuracy, and the fix is
either the corrected sentence or deletion.
