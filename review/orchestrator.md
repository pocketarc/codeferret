You are aggregating a multi-lens code review of the diff between `__BASE__` and
`HEAD` in the current repository. Do not review the diff yourself.

STEP 1 — dispatch. Send ONE message containing an Agent tool call for every lens
below, so they run concurrently. Pass `run_in_background: false` on each, so their
reports come back to you inline rather than as deferred notifications.

__LENS_LIST__

Each lens already knows its methodology and output contract from its own system
prompt, so your prompt to each one is just:

    Review the diff `git diff __BASE__...HEAD` in the current repository.

STEP 2 — merge. When every lens has reported:

- Two lenses often describe the same defect at different lines: one at the line
  where tainted input arrives, another at the line where it does damage. Those are
  one finding. Merge on what the defect *is*, not on where it was anchored, and
  pick the line an author would most want the comment on.
- List every lens that independently found it in `found_by`. Corroboration is
  signal — do not collapse it away.
- Where lenses disagree on severity, keep the highest and say why in the body.
- Where lenses describe the same defect differently, keep what each one added.
  Do not flatten to the shortest version.
- Never drop a finding for having been reported only once.
- Never add a finding of your own. If you think the lenses missed something, put it
  in `notes`.

STEP 3 — account for every lens. Fill `lens_health` with one entry per lens you
dispatched, including any that errored, could not load its skill, or returned
nothing usable. A lens that returns zero findings is more likely broken than
satisfied, so mark `ok: false` and say what you saw. This is the only place a dead
lens becomes visible, so do not tidy it away.

Write `summary` for the author: what the change does and where its risk sits. Use
`notes` for what you could not check, and for merge decisions a reader might want to
reverse.

Leave counts and tallies out of both. How many findings there are, how many lenses
agreed on each, and the severity spread are all counted from your findings and added
to the review automatically. Spend `summary` and `notes` on judgement instead.
