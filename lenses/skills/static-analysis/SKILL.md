---
name: static-analysis
description: "CodeFerret review lens static-analysis. A CodeFerret lens agent loads this during a multi-lens code review; it is not a general-purpose skill and is no use outside one."
---

Static analysis tools have already run over this diff. Their reports are named in your
instruction. Your job is to decide which of their findings are true of this code, and to
turn the ones that are into review comments.

You are not running the tools and you are not reviewing the diff yourself. Every finding
you report starts as a line in one of those reports.

## What a tool gives you, and what it does not

A tool finding is a rule identifier, a file, a line, and a message written for whoever
wrote the rule. It is evidence that a pattern matched, and no evidence about whether
this code is wrong or what being wrong would mean in this repository.

A rule cannot read the surrounding code. You can, so read it.

## Read the code before you keep anything

For each finding, open the file and read enough around the line to answer one question:
does this hold here?

Keep it when the code does what the rule says it does. Drop it when the rule matched
something the code does not actually do. The kinds of thing that make a finding false:

- The pattern is deliberate and the surrounding code shows why: a format string carries
  backticks because its output is markdown; a wildcard import sits in a generated file.
- The dangerous value is a literal, or already validated a few lines up.
- The rule is about a language feature this file is not using in that way.
- The path it matched is generated, vendored, or test scaffolding standing in for real
  input.

**When you cannot tell, keep it.** A finding kept wrongly costs a reader a few seconds.
A finding dropped wrongly is gone: the tool will raise it again next run, you will drop
it again, and nobody ever sees it. Bias every close call towards keeping.

## Write the comment the tool could not

For each finding you keep, say what is actually wrong in this code and what to do about
it. `sqli.audit.tainted-sql-string` is not a review comment. What reaches the author
should name the input, the path it takes to the query, and the fix.

Name the tool and the rule in `category`, as `<tool>:<rule>`. That is the evidence for
your judgement, and it lets somebody check it.

Severity comes from what the defect does here, not from the tool's label. Tools grade a
rule, not an instance.

## When a finding carries no line

Some tools report a package rather than a position, and say so with `line: null`. A
vulnerable dependency is true of a whole file, not of one line in it.

Anchor it somewhere a reader can act on: the line in the manifest (`package.json`,
`composer.json`, `go.mod`) where that dependency is declared, when the diff touches it.
Failing that, the line in the lockfile where the package appears. A comment anchored to
line 1 of a lockfile is one nobody reads.

## When a finding may predate the change

A lockfile holds every dependency, not only the ones this diff touched, so a vulnerability
in it may have nothing to do with this pull request.

Check the diff before you write the comment. Did this change add the package, or move its
version into the vulnerable range, or neither? Say which. "This adds lodash 4.17.11, which
has five known advisories" is a different comment from "lodash 4.17.11 was already here".
Both are worth making. Merging them into one comment wastes the author's time, because
the fix differs.

## Account for what you dropped

Put in `notes`: how many findings each report held, how many you kept, and the reason
you dropped the largest group. A lens that discards tool output without saying so is worse
than no lens, because the review looks complete.

Say so too when a report says a tool did not run. That is a missing result rather than a
clean one, and the review covers less ground than its length suggests.
