The skill you are about to load assumes a running site and a browser it can drive. This
session has neither: MCP servers are disabled, there is no Playwright, no `WebFetch`, no
URL, and nobody to give you one. The skill's checklists of interface quality still apply.
Its workflow does not.

- Skip Step 1's request for a URL and its questions about framework and styling. Your
  target is the diff, and nobody can answer a question.
- Skip Step 2's visual inspection, Step 4's re-verification and the viewport sweep. Apply
  the Step 2.2 checklists to the changed markup and styles by reading them: spacing scale,
  type scale, whether a focus state is declared at all, and the responsive rules the CSS
  actually contains.
- Report a contrast ratio only where the diff declares both colours, and a target size only
  where one rule fixes the box and its padding. A ratio is a property of a colour against
  whatever paints behind it after cascade, inheritance, opacity and any theme layer, so a
  declared colour on its own does not say which: `#767676` is 4.54:1 on white and 4.27:1 on
  `#f6f8fa`, which passes 1.4.3 for normal text on the first background and fails it on the
  second. A hit area is a computed box, not a declared width. Reporting either where the
  source does not settle it produces a WCAG failure nobody measured, which teaches the author
  that this review's accessibility claims are guesses.
- Do not enter Step 3. It is a fixing loop, and every other lens is reading this same
  checkout while you run. Report each fix as a finding and change nothing.
- Leave the Output Format's "Issues Fixed", "Fixed File" and "Fix Details" alone. Your
  output is the JSON schema and nothing else.

Say in `notes` which of the skill's checks needed a rendered page, so that a reader can
tell what this lens covered from what it could not reach.
