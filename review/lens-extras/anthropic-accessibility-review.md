There is no rendered page in this session, and no browser, screen reader or contrast tool
to point at one. What you have is the source in the diff.

That covers a real share of WCAG statically: missing alternative text, an unlabelled form
control, a heading level skipped, a handler on a non-interactive element, a `tabindex`
above zero, an ARIA attribute on a role that does not take it, a language attribute, a
table without headers.

The rule for the rest: a criterion whose outcome depends on a computed style, a live focus
ring, an accessibility tree, timing or motion cannot be decided here. That rules out
contrast, focus order, target size, reflow, text spacing, content on hover, keyboard traps,
timing limits, moving or flashing content, any change of context on focus or input, and the
computed accessible name and role an assistive technology would announce. Do not report one
as passing, do not guess a contrast ratio from a source colour whose background you cannot
see, and do not describe what a screen reader would say.

Four parts of the skill contradict the paragraph above, and that paragraph overrides all
four. Three are tables in its Output template, and every cell in each of them would be
invented: "Color Contrast Check" has a column for a computed ratio per element, "Keyboard
Navigation" one for a rendered tab order and the runtime behaviour of four keys, and
"Screen Reader" an "Announced As" column. Leave all three out entirely. The fourth is its
Tip 1, which puts contrast first: start with keyboard instead, meaning the part of 2.1.1
that the source settles (a handler on a non-interactive element, a control with no keyboard
affordance written into it) and the rest of the statically checkable set below.

Two of those have a source-level failure worth reporting, and reporting it is not the same
as judging the rendered result:

- A focus rule that removes the default indicator without declaring a replacement.
  `outline: none` or `outline: 0` on `:focus` or `:focus-visible` with no `outline`,
  `box-shadow`, `border` or background substitute in that rule or a sibling is a 2.4.7
  failure whatever it renders as. Whether an indicator that is there is visible enough is
  the part you cannot decide.
- A positive `tabindex`, which takes an element out of document order. Whether the
  resulting order is logical is the part you cannot decide.

Name in `notes` the criteria the changed files would otherwise have raised and that you
could not evaluate without rendering. Say it plainly and in one place: the orchestrator is
told to carry what a lens could not check into that lens's own line of the posted review,
and it can only carry what you have written down. Without that line, a pull request full of
interface changes comes back looking as though its accessibility had been checked.
