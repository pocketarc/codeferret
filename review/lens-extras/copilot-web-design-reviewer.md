---
standing-detail: >-
  No page was rendered, so nothing that depends on one was evaluated, among them element
  overflow and overlap, alignment and computed spacing, the mobile, tablet, desktop and wide
  viewport sweep, whether the resulting keyboard tab order is logical, whether text visibly
  clips or its ellipsis renders, computed line height and characters per line,
  focus-indicator visibility, whether a declared hover, active, disabled or loading state is
  visually distinct enough, whether a chart or a diagram is still legible with a colour vision
  difference, how an image renders at another pixel density or what stands in for it when it
  fails to load, and layout shift on load. A contrast ratio or a target size is reported only
  where the diff, or a file read alongside it, settles the colour pair or the box outright;
  neither was reached otherwise.
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
  `references/visual-checklist.md` under the skill's own directory, which the skill links
  from nowhere and which holds the checks Step 2.2 only summarises. Apply the sections the
  source settles without a rendered page: Fonts and the declared half of Text Handling
  under Typography (whether a block that holds unbreakable text declares `overflow-wrap` or
  `text-overflow`, not whether it visibly clips or an ellipsis renders), Color Consistency,
  the markup halves of Buttons, Links and Form Elements,
  the source half of Keyboard Navigation (whether an interactive element is
  reachable at all, whether a modal declares a trap, whether a skip link exists, not
  whether the resulting tab order is logical), alt text under Images, and
  `prefers-reduced-motion` under Motion. Anything else readable from the source is in scope
  whether or not it is named there: a declared fixed width on a fluid container, whether a
  focus state is declared at all, and a font or a colour that matches no other in the
  change. Responsive Verification goes with the sweep except for the part the document head
  settles. A page with no `<meta name="viewport">` is laid out on a phone at a fallback width
  near 980 CSS pixels and then scaled down to fit, so every media query is evaluated against
  that width and no mobile breakpoint in the change ever matches, and the text is rendered at
  roughly a third of the size it was written for. Report the unmatched breakpoints and the
  shrunken text from the head alone. The scaling is also why "Content fits within screen
  width" and "No horizontal scrolling occurs" pass for any layout that fallback width fits,
  so report neither of those against a page whose tag is missing; and a
  viewport tag carrying `user-scalable=no`, or a `maximum-scale` below 2, caps zoom below
  200%, which fails 1.4.4 Resize Text (Level AA). Report those. Whether a layout survives at
  375px is the rendered half and stays out.
- Report a contrast ratio only where the source settles both the text colour and everything
  painting behind it, in this diff or in a file you can read alongside it, and never where a
  theme layer, an opacity or an inherited background leaves the backdrop open. A ratio is a
  property of a colour against whatever paints behind it after cascade, inheritance, opacity
  and any theme layer, so a declared colour on its own does not say which: `#767676` is 4.54:1
  on white and 4.27:1 on `#f6f8fa`, which passes 1.4.3 for normal text on the first background
  and fails it on the second. The test is whether the source settles the pair, not where the
  two were written: a colour the diff changes on an element whose background comes from an
  untouched rule is the ordinary case, and the source settles it. Report a target size only
  where the source fixes the whole border box: `width`, `height`, `padding`, `border-width`
  and the `box-sizing` in force, whether one rule settles them or several you can read
  together. A hit area is a computed box rather than a declared width, and the declarations
  around the width change what it computes to: `width: 24px; padding: 4px` is a 32px target
  under `content-box` and a 24px target under `border-box`. Where nothing you can read
  settles the `box-sizing` in force, the box is unsettled and there is nothing to report.
  The bar is 24 by 24 CSS pixels, which is 2.5.8 Target Size (Minimum), Level AA, added in
  WCAG 2.2. The checklist's 44 by 44 is 2.5.5 Target Size (Enhanced), Level AAA, so a box
  between the two fails 2.5.5 and passes 2.5.8: name the criterion and its level, or a
  reader takes an AAA shortfall for an AA failure. 2.5.8 has exceptions for a target inline
  in a sentence and for one whose size the user agent sets and the page does not, so leave
  those. Reporting
  either where the source does not settle it produces a WCAG failure nobody measured, which
  teaches the author that this review's accessibility claims are guesses.
- Do not enter Step 3.3. It is the fixing loop, and every other lens is reading this same
  checkout while you run. Report each fix as a finding and change nothing. Steps 3.1 and 3.2
  stay, and neither writes anything: 3.1 is a priority matrix, and 3.2's selector and
  component searches and file patterns are how you get from a piece of markup to the rules
  that style it.
- Grade on the schema's `severity` field and nothing else. Step 2.2's tables carry a
  `Severity` column, Step 3.1 is a P1 to P3 matrix, and `references/visual-checklist.md`
  carries a P0 to P3 one under `## Priority Matrix`. Those are three of upstream's own scales
  and none of them is the enum you have to return, so read each as a statement about how much
  a defect matters and then choose a value from the schema.
- Leave the Output Format's "Issues Fixed", "Fixed File" and "Fix Details" alone. Your
  output is the JSON schema and nothing else.

Say in `notes` which of the skill's checks needed a rendered page, so that a reader can
tell what this lens covered from what it could not reach.
