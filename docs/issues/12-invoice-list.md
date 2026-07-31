# #12 — Invoice list and detail view

## Goal

Let a signed-in user browse their own invoices and open one to see its line
items and notes.

## Requirements

1. `GET /invoices` returns the authenticated user's invoices, **paginated at 25
   per page**, newest first.
2. `GET /invoices/{id}` returns a single invoice with its line items. A user may
   only open an invoice they own; anything else is a 404.
3. Invoices can be filtered by status via `?status=`. Accepted values are
   `draft`, `sent`, and `paid`. Any other value is a 422.
4. The detail view renders the invoice's `notes` field. Notes are authored by the
   invoice owner and may contain line breaks, but are **plain text**.
5. Totals shown in the UI must match the stored amount exactly — no floating
   point arithmetic anywhere in the path.

## Explicitly out of scope

- Export in any format (CSV, PDF, XLSX). Tracked separately as #19.
- Editing or creating invoices. This issue is read-only.
- Any change to the invoice schema.
