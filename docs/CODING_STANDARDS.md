# Coding standards

These are the documented standards for this repo. A review that cites a standard
must cite it by the rule name below.

## PHP

1. **No raw SQL.** All database access goes through the query builder or Eloquent.
   String-interpolated SQL is never acceptable, even for values the author
   believes are internal.
2. **Money is a type.** Monetary amounts use `App\Support\Money` (integer minor
   units). Never `float`, never a bare `int` passed around as "cents".
3. **Controllers stay thin.** A controller action validates, delegates to a
   service, and returns. Business logic lives in `app/Services/`.
4. **Explicit ownership checks.** Any action that loads a record by an ID from
   the request must verify the record belongs to the authenticated user before
   returning or mutating it.
5. **No `shell_exec`/`exec`/`proc_open`.** Shelling out is banned. Use a library.

## TypeScript

6. **No `dangerouslySetInnerHTML`.** Render text as text. If markup is genuinely
   required, it goes through the sanitizer in `frontend/src/lib/sanitize.ts`.
7. **Secrets come from the environment.** Never inline a key, token, or password
   in source. Server-only secrets never appear in client-reachable modules.
8. **Reuse the formatting helpers.** Currency and date formatting live in
   `frontend/src/lib/format.ts`. Do not reimplement them.

## Both

9. **Every production file has a matching test.** TS tests are co-located
   (`foo.ts` next to `foo.test.ts`). PHP tests mirror under `tests/`.
