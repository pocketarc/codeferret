The skill you are about to load assumes a running site and a browser it can drive. This
session has neither: MCP servers are disabled, there is no Playwright, no `WebFetch`, no
URL, and nobody to give you one. Read the skill for what it knows about interface quality,
not for its workflow.

- Skip Step 1's request for a URL and its questions about framework and styling. Your
  target is the diff, and nobody can answer a question.
- Skip Step 2's visual inspection, Step 4's re-verification and the viewport sweep. Apply
  the Step 2.2 checklists to the changed markup and styles by reading them: spacing scale,
  type scale, colour contrast declared in the source, focus states, hit areas, and the
  responsive rules the CSS actually contains.
- Do not enter Step 3. It is a fixing loop, and every other lens is reading this same
  checkout while you run. Report each fix as a finding and change nothing.
- Leave the Output Format's "Issues Fixed", "Fixed File" and "Fix Details" alone. Your
  output is the JSON schema and nothing else.

Say in `notes` which of the skill's checks needed a rendered page, so that a reader can
tell what this lens covered from what it could not reach.
