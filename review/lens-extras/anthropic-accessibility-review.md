---
standing-detail: >-
  No page was rendered, so focus order, reflow, text spacing, timing limits, flashing and
  what an assistive technology announces were not evaluated. A contrast ratio or a target
  size is reported only where the source settles the colour pair or the border box outright;
  neither was reached otherwise. Also not
  evaluated: whether a focus indicator is visible enough, whether anything that moves is
  distracting, and whether content revealed on hover is dismissible, hoverable and
  persistent.
---

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
- A missing `lang` on `<html>` (3.1.1, Level A), and a passage in another language carrying
  none of its own (3.1.2, Level AA).
- A table without headers.
- An input whose purpose is one WCAG names and which carries no `autocomplete` token
  (1.3.5).
- `<audio autoplay>`, or `<video autoplay>` carrying an audio track, with neither `controls`
  nor `muted` (1.4.2). 1.4.2 is about audio that starts on its own, so silent video is
  outside it.
- `<video autoplay loop>` with no `controls`, where something else is presented alongside it
  (2.2.2, Level A). `autoplay` settles automatic start and `loop` settles the five-second
  threshold. The third condition, that the motion runs in parallel with other content, is the
  one the surrounding markup has to show, and a full-bleed hero with nothing beside it does
  not meet it. The 2.2.2 bullet below has the three conditions in full.
- A link whose whole accessible content is "click here" or "read more" and whose surrounding
  markup supplies no purpose either (2.4.4). 2.4.4 is Link Purpose (In Context), so the
  enclosing sentence, list item, table cell or heading counts; the source usually shows it.
- A duplicated `id` that a `<label for>` or an `aria-labelledby` points at, which binds to
  the first match and leaves the second control with no accessible name (1.3.1, and 4.1.2
  for the control left unnamed). Not 4.1.1: the WCAG 2.1 errata make it always satisfied,
  and WCAG 2.2 removed it.

The rule for the rest: a criterion whose outcome depends on a computed style, a live focus
ring, an accessibility tree, timing or motion cannot be decided here. That rules out focus
order, reflow, text spacing, timing limits, and what an assistive technology announces from
an element that does have a name. Do not report one as passing, and do not describe what a
screen reader would say.

Contrast and target size are the two the source does sometimes settle on its own, and the
rule above does not reach them where it does:

- 1.4.3 Contrast (Minimum), Level AA. Report a ratio where the source settles both the text
  colour and everything painting behind it, in the diff or in a file you can read alongside
  it, and nowhere else. A ratio is a property of a colour against whatever paints behind it
  after cascade, inheritance, opacity and any theme layer, so a declared colour on its own
  does not say which: `#767676` is 4.54:1 on white and 4.27:1 on `#f6f8fa`, which passes
  1.4.3 for normal text on the first and fails it on the second. Never guess one from a
  colour whose backdrop a theme layer, an opacity or an inherited background leaves open.
  The bar is 4.5:1, or 3:1 for large text, meaning 18 point, or 14 point bold.
- 2.5.8 Target Size (Minimum), Level AA. Report a size where the source fixes the whole
  border box: `width`, `height`, `padding`, `border-width` and the `box-sizing` in force,
  whether one rule settles them or several you can read together. A hit area is a computed
  box rather than a declared width, and `width: 24px; padding: 4px` is a 32px target under
  `content-box` and a 24px one under `border-box`. Where nothing you can read settles the
  `box-sizing`, the box is unsettled and there is nothing to report. 2.5.8 exempts a target
  inline in a sentence, one the spacing around it makes up for, one with an equivalent
  control elsewhere on the page, one whose size the user agent sets and the page does not,
  and one whose size is essential, so leave any target an exception covers.

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
- 3.2.1, change of context on focus (Level A). A handler that navigates or submits a form
  from `onFocus` is a source fact. Whether a subtler change counts as a change of context is
  not.
- 3.2.2, change of context on input (Level A). The same for `onChange`, and for a form
  submitted when a value changes. Do not file an `onFocus` handler here: focus and input are
  separate criteria, and the skill's own quick reference names only 3.2.1.
- 2.2.2, moving content. Three conditions have to hold together before 2.2.2 Pause, Stop,
  Hide (Level A) applies and a mechanism to pause, stop or hide is needed: the motion starts
  automatically, it lasts more than five seconds, and it is presented in parallel with other
  content. A declared duration settles the second of them and nothing else.
  Duration: a CSS `animation` whose `animation-duration` multiplied by its
  `animation-iteration-count` runs past five seconds clears it, `infinite` being the case
  where that product is unbounded, and a finite `animation: slide 20s ease-in-out 1` clearing
  it too. Automatic start: the source has to show the animation applied with no interaction
  in the way, on a selector no interaction state narrows or through a class the initial
  markup already carries. One reached only through `:hover`, `:focus`, `:active`, a class a
  handler toggles, a scroll position or a view transition is outside 2.2.2 however long it
  runs, and belongs to 2.3.3 below. In parallel: a loader that fills the viewport with
  nothing beside it is not, and the markup usually shows whether anything sits beside it.
  A `transition` has no iteration count and cannot be set to `infinite`, so it is outside
  this bullet. Whether the source carries a pause mechanism anywhere is a source fact.
- 2.3.3, motion from interactions. A `@media (prefers-reduced-motion: reduce)` block is
  technique C39, which is sufficient for this criterion under WCAG and not for 2.2.2. 2.3.3 is
  Level AAA. Name the level if you name the criterion.

  The criterion covers motion animation triggered by interaction, and nothing else, so cite it
  only where the source shows a user action starting the motion: a `:hover` or `:focus` rule
  that animates, an animation applied by a class a handler toggles, a scroll-linked animation,
  a route or view transition. An animation that starts on page load or runs on its own cannot
  fail a criterion whose trigger condition was never met, however the reduced-motion query is
  written, so a missing block is not a 2.3.3 failure on its own. Where such an animation also
  falls under the 2.2.2 threshold above, the source settles no criterion: say the block is
  missing and name none.
- Neither of those covers flashing. Three flashes in a second is 2.3.1 (Level A), it needs
  the rendered page, and so does whether what moves is distracting at all.

Parts of the skill contradict the rules above, and the rules override them. Its Output
template holds tables it asks you to fill a row of per element, and the source settles almost
none of the cells: "Color Contrast Check" wants a computed ratio for each one, "Keyboard
Navigation" a rendered tab order and what each key does at runtime, and "Screen Reader" an
"Announced As" column. Leave those tables out entirely. A ratio the source does settle
belongs in a finding rather than in a row beside a column of blanks. Its Tip 1 puts contrast first: start with keyboard instead, meaning the
part of 2.1.1 the source settles and the rest of the set above.

Its "Testing Approach" is a workflow for a page you can open, and four of its five steps have
nothing to run against here. Skip steps 1, 3, 4 and 5 outright: there is no scanner, no
screen reader, no rendered colour and nothing to zoom. Step 2 means the source half of 2.1.1
described above, not a live tab-through. The rule above already rules out what those steps
would report, and this paragraph rules out going looking: a lens told to follow the procedure
spends its budget hunting for a page to run it against.

Its "Common Issues" list is a different case and stays in scope. Items 5 and 6, focus traps
in modals and missing ARIA landmarks, are both decidable from source.

One correction to the skill's quick reference: its list is headed "WCAG 2.1 AA" and lists
2.5.5 Target Size under it. 2.5.5 is Level AAA, and its bar is 44 by 44 CSS pixels. The AA
criterion is 2.5.8 Target Size (Minimum), added in WCAG 2.2, at 24 by 24. A box between them
fails 2.5.5 and passes 2.5.8, so name the criterion and its level, or a reader takes an AAA
shortfall for an AA failure.

Name in `notes` the criteria the changed files would otherwise have raised and that you
could not evaluate without rendering. Say it plainly and in one place: the orchestrator is
told to carry what a lens could not check into that lens's own line of the posted review,
and it can only carry what you have written down. Without that line, a pull request full of
interface changes comes back looking as though its accessibility had been checked.
