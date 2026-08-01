STEP 4 — close what is finished. Fill `resolve` with the threads that are done, each with
a one-line reason. This is a judgement on each thread, not a rule: `resolved` and
`outdated` are evidence you weigh, not conditions that decide for you.

A thread is finished when the defect it describes is gone from the code, or when someone
settled it. `outdated: true` means the line it pointed at has changed, which is evidence a
fix landed there and nothing more; a fix elsewhere leaves a thread current, and an
unrelated edit above it makes a live thread outdated. Read the diff and decide.

Three threads to leave open:

- One you did not open. `mine: false` marks a human's thread, and closing it takes their
  words off the page.
- One whose last comment asks a question nobody answered. Closing it loses the question.
- One you are unsure about. An open thread costs the author a glance; a closed thread
  costs them the finding, and nothing will raise it again.

A thread already carrying `resolved: true` needs no entry.
