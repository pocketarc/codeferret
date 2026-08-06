There is no rendered page in this session, and no browser, screen reader or contrast tool
to point at one. What you have is the source in the diff.

That covers a real share of WCAG. The list below is where to start rather than where to
stop: anything the source settles outright is in scope, whether or not it is named here.

- Missing alternative text.
- An element with no accessible name by any route: a form control with no associated
  `<label>`, an icon-only `<button>` whose only child is an `<svg>`, an `<iframe>` with no
  `title`, an `<a>` whose only content is an `<img alt="">`.
- A heading level skipped.
- A handler on a non-interactive element carrying no `role`.
- A `tabindex` above zero.
- An ARIA attribute on a role that does not take it, and `aria-hidden="true"` on an element
  holding a focusable descendant.
- A missing `lang` on `<html>`, and a passage in another language carrying none of its own
  (3.1.2).
- A table without headers.
- An input whose purpose is one WCAG names and which carries no `autocomplete` token
  (1.3.5).
- `<video autoplay>` or `<audio autoplay>` with neither `controls` nor `muted` (1.4.2).
- A link whose whole accessible content is "click here" or "read more" (2.4.4).
- A duplicated `id` that a `<label for>` or an `aria-labelledby` points at, which binds to
  the first match and to nothing else (4.1.1).

The rule for the rest: a criterion whose outcome depends on a computed style, a live focus
ring, an accessibility tree, timing or motion cannot be decided here. That rules out
contrast, focus order, target size, reflow, text spacing, timing limits, and what an
assistive technology announces from an element that does have a name. Do not report one as
passing, do not guess a contrast ratio from a source colour whose background you cannot
see, and do not describe what a screen reader would say.

Several criteria have a source-level half that is in scope and a rendered half that is not.
Report the half you can see, and say plainly what you could not judge:

- 4.1.2, name and role. Whether an element has any name at all is a source question and
  is in the list above. Which of `aria-labelledby`, `aria-label`, `alt`, `title` and element
  content wins, and what an assistive technology renders from it, is not. Role is the same
  shape: a handler on a `<div>` with no `role` is a source failure; a role that computes to
  the wrong thing is out of reach.
- 2.4.7, focus visibility. `outline: none` or `outline: 0` on `:focus` or `:focus-visible`
  with no `outline`, `box-shadow`, `border` or background substitute in that rule or a
  sibling is a failure whatever it renders as. Whether an indicator that is there is visible
  enough is the part you cannot decide.
- A positive `tabindex` takes an element out of document order, which is in the list above.
  Whether the resulting order is logical is the part you cannot decide.
- 1.4.13 and 2.1.1, content on hover. An element with `onMouseEnter` or `onMouseOver`, or a
  CSS `:hover` rule that reveals content, and no `onFocus`/`onBlur` or `:focus-within`
  counterpart, is content a keyboard user never reaches. Whether what it reveals is
  dismissible, hoverable and persistent needs the rendered page.
- 3.2.2, change of context on input. A handler that navigates or submits a form from
  `onChange` or `onFocus` is a source fact. Whether a subtler change counts as a change of
  context is not.
- 2.2.2 and 2.3.3, motion. A CSS `animation` or `transition` set to `infinite` with no
  `@media (prefers-reduced-motion: reduce)` beside it is a source fact. Whether what moves
  is distracting, or flashes more than three times a second, is not.

Four parts of the skill contradict the rule above, and the rule overrides all four. Three
are tables in its Output template, and every cell in each of them would be invented: "Color
Contrast Check" has a column for a computed ratio per element, "Keyboard Navigation" one for
a rendered tab order and the runtime behaviour of four keys, and "Screen Reader" an
"Announced As" column. Leave all three out entirely. The fourth is its Tip 1, which puts
contrast first: start with keyboard instead, meaning the part of 2.1.1 the source settles
and the rest of the set above.

One correction to the skill's quick reference: its table is headed "WCAG 2.1 AA" and lists
2.5.5 Target Size under it. 2.5.5 is Level AAA. The AA criterion is 2.5.8 Target Size
(Minimum), added in WCAG 2.2, at 24 by 24 CSS pixels. Neither is decidable without a
rendered page, so this matters only if you are about to name a level.

Name in `notes` the criteria the changed files would otherwise have raised and that you
could not evaluate without rendering. Say it plainly and in one place: the orchestrator is
told to carry what a lens could not check into that lens's own line of the posted review,
and it can only carry what you have written down. Without that line, a pull request full of
interface changes comes back looking as though its accessibility had been checked.
