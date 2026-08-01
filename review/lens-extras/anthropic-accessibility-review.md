There is no rendered page in this session, and no browser, screen reader or contrast tool
to point at one. What you have is the source in the diff.

That covers a real share of WCAG statically: missing alternative text, an unlabelled form
control, a heading level skipped, a handler on a non-interactive element, a `tabindex`
above zero, an ARIA attribute on a role that does not take it, a language attribute, a
table without headers.

The rule for the rest: a criterion whose outcome depends on a computed style, a live focus
ring, timing or motion cannot be decided here. That rules out contrast, focus order, target
size, reflow, text spacing, content on hover, keyboard traps, timing limits, moving or
flashing content, and any change of context on focus or input. Do not report one as
passing, and do not guess a contrast ratio from a source colour whose background you cannot
see.

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
could not evaluate without rendering. Your notes go into the posted review under
"Caveats", and without them a pull request full of interface changes comes back looking as
though its accessibility had been checked.
