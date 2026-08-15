---
standing-detail: No browser was available, so nothing was judged from a rendered page.
---

The skill you are about to load assumes a running site and a browser it can drive. This
session has neither: MCP servers are disabled, there is no Playwright, no `WebFetch`, no
URL, and nobody to give you one. The skill's checklists of interface quality still apply.
Its workflow does not.

- Skip Step 1.1's request for a URL and Step 1.2's questions about the project, which
  nobody can answer. Steps 1.3 and 1.4 stay: reading `package.json`, `tailwind.config`,
  `next.config`, `vite.config` and `src/` or `app/`, and mapping `*.module.css`,
  `tailwind.config.*`, `styled.` and `@emotion/` to where the styles live, is how a review
  with no browser finds anything to read at all.
- Skip Step 2's visual inspection, Step 4's re-verification and the viewport sweep. Read
  `references/visual-checklist.md`, which the skill links from nowhere and which holds the
  checks Step 2.2 only summarises. Apply the sections the source settles without a rendered
  page: text handling and fonts under Typography, Color Consistency, the markup halves of
  Buttons, Links and Form Elements, Keyboard Navigation, alt text under Images, and
  `prefers-reduced-motion` under Motion. Anything else readable from the source is in scope
  whether or not it is named there: a declared fixed width on a fluid container, a block
  with no `overflow-wrap` or `text-overflow` around text that cannot wrap, whether a focus
  state is declared at all, and a font or a colour that matches no other in the change.
- Report a contrast ratio only where the diff declares both colours, and a target size only
  where one rule fixes the box and its padding. A ratio is a property of a colour against
  whatever paints behind it after cascade, inheritance, opacity and any theme layer, so a
  declared colour on its own does not say which: `#767676` is 4.54:1 on white and 4.27:1 on
  `#f6f8fa`, which passes 1.4.3 for normal text on the first background and fails it on the
  second. A hit area is a computed box, not a declared width. Reporting either where the
  source does not settle it produces a WCAG failure nobody measured, which teaches the author
  that this review's accessibility claims are guesses.
- Do not enter Step 3.3. It is the fixing loop, and every other lens is reading this same
  checkout while you run. Report each fix as a finding and change nothing. Steps 3.1 and 3.2
  stay, and neither writes anything: 3.1 is a priority matrix, and 3.2's selector and
  component searches and file patterns are how you get from a piece of markup to the rules
  that style it.
- Grade on the schema's `severity` field and nothing else. Step 2.2's tables carry a
  `Severity` column, Step 3.1 is a P1 to P3 matrix, and `references/visual-checklist.md` ends
  with a P0 to P3 one. Those are three of upstream's own scales and none of them is the
  enum you have to return, so read each as a statement about how much a defect matters and
  then choose a value from the schema.
- Leave the Output Format's "Issues Fixed", "Fixed File" and "Fix Details" alone. Your
  output is the JSON schema and nothing else.

Say in `notes` which of the skill's checks needed a rendered page, so that a reader can
tell what this lens covered from what it could not reach.
