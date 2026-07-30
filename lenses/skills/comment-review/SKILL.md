---
name: comment-review
description: Review the comments a change adds or leaves behind. Finds comments that restate the code, narrate history, or document an absence, and comments the change has made untrue. Use when reviewing a diff for whether its prose earns its place.
---

# Comment Review

Comments are written for a principal engineer. They read the code to learn what it does,
infer what each construct is for, and check history when they want a timeline. A comment
earns its place by carrying something that reader cannot reach.

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

Yes, and the comment goes. No, and only the part they could not infer stays, in as few
words as it takes.

Judge it blind: read the code with the comment covered, decide what you can work out
unaided, then compare that against what the comment claims.

The strongest tell is a comment answering a question only the author was asking. While
writing, an author holds the options they rejected and the bug they just fixed; the
reader arrives with neither, sees a deliberate construct, and asks nothing. A comment
addressed to that deliberation is written to a reader who is not there.

Score each claim in a comment separately. A comment mixing one real constraint with three
sentences of narration keeps the one.

## Every construct is deliberate

The reader assumes intent. A timeout implies a timing problem, a retry implies flakiness,
a null guard implies null arrives, a pinned version implies a bad release. None of that
needs saying.

```ts
// Bumped to 60s because the default 30s timed out on cold compiles.
timeout: 60_000,
```

A raised timeout tells the reader there was a timing problem, and `git log -S` gives them
the commit, the date, and the message.

## Enforce it before explaining it

> If someone violated this, would anything fail?

If nothing would, the fix is a test or a lint rule. An invariant worth writing down is
worth enforcing, and once enforced the comment is redundant: whoever breaks it finds out
from the failure, which can carry the reason.

"These two lists must stay in sync" is a test. "This must run before that" is often an
assertion. A comment is right when mechanising costs more than it protects, and saying so
is the interesting part.

## What earns its place

Knowledge the reader cannot reach from the code in front of them, where lacking it would
lead them to change the code wrongly.

- **An invariant the design rests on**, where enforcing it mechanically is impractical.
  The condition that, if it stopped holding, would make this code wrong.
- **An external fact.** A vendor quirk, an upstream bug, a spec footnote, a wire-format
  constraint. The cause lives outside the repository, so reading harder will not reach it.
  Say how it bears on this line: a fact whose connection to the code is missing reads as
  trivia, and a comment about a tool the code does not use reads as a non sequitur.
- **A constraint that looks arbitrary.** Ordering that must hold, a call that must not be
  hoisted, two values that must agree. The tell is that the obvious tidy-up breaks it
  without failing a test.
- **A rejected alternative that looks correct**, where the reader would otherwise try it
  and the failure would be silent or expensive. If the wrong path fails loudly on the next
  test run, say nothing.
- **A domain rule the code cannot express.** Why invoices freeze an exchange rate on
  payment. Business truth, not mechanism.

Prefer the conditional form. Given a choice between explaining the decision and naming the
condition it depends on, the condition is what stops someone breaking it later.

## What does not

- Restating the code: `// increment the counter` above `count++`.
- **Documenting an absence.** "No checkout step here because…", "we deliberately don't
  cache this". Nobody reads a file asking why it lacks something.
- **Defining by comparison.** "Uses X rather than Y", "not the Z approach", "instead of
  …". The reader has only the code in front of them, so the discarded option is a
  stranger to them. State the constraint that makes the chosen one necessary.
- **A fact with no referent.** Prose about a tool, platform, or approach this code does
  not use. Trimming often creates these: cutting the sentence that connected an external
  fact to the line leaves the fact stranded.
- History: "this used to be", "previously we", "now that we've added". Commit messages
  hold this.
- Reasoning a test already demonstrates. Point at the test if the link is not obvious.
- Well-known API semantics: how `useEffect` cleanup works, what `Promise.all` rejects on.
- Why this API and not the neighbouring one, when the code makes the reason evident.
- Signposting: "note that", "the important part is below", "as mentioned above".
- Justifying the obviously correct. Nobody needs persuading that input is validated.
- The same point in two files. Keep it where a reader will be standing when they need it.

## On a diff

- **Comments the change made untrue.** A comment describing behaviour the diff has just
  altered misleads, so check every comment adjacent to a changed line, not only the ones
  the diff adds.
- **A comment doing a rename's work.** Prose explaining what a variable holds means the
  variable is misnamed.
- **A hunk that is mostly prose.** The finding is the code, not the comment.

## Reporting

Anchor each finding on the comment's first line. Describe the reader's position: what the
code already tells a principal engineer, and what it withholds. The author writes the
replacement.

- **Delete.** Everything the comment claims is reachable from the code. Name what the
  reader works out unaided that makes the comment redundant.
- **Trim.** Part is reachable and part is not. Name both: the part a principal engineer
  grasps from the code, and the fact they could not have.

A finding reads like this: "A principal engineer reads a raised timeout as a timing
problem, so the first two sentences carry nothing. The vendor's 90s ceiling is the fact
the code withholds."

For a comment the change made untrue, the finding is the inaccuracy.
