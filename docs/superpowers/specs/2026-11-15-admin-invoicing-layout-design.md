# Admin invoicing layout, modelled on Zoho Invoice (#854)

## Intent

The owner (sole administrator, non-designer) finds the admin side of coaching
hours, approval and invoices "very raw". They asked to learn from Zoho
Invoice's layouts and make the experience feel like a professional invoicing
tool. The capability already exists (review, issue, send, record payment,
refund, void, recurring); what is missing is the way it is presented: one long
scroll of full forms, no overview of money owed or work waiting, no status
views, and no sense of "what do I do next".

## Goals

- At a glance on **Invoices**: how much is outstanding, how many invoices are
  unpaid, how many are not sent, how many months of hours await review.
- **Status views** on the invoice list, like Zoho's view switch.
- An **invoice page** that shows the document first, with one action bar and
  the actions opening as small panels, a "What's next" box, a clear status
  badge, and a short timeline.
- A **review queue** for submitted hours that reads like a work list.

## Non-goals

- No stored-data changes: no due dates, overdue or aging, no short sequential
  invoice numbers, no issuing straight from a draft. Those are a later,
  separate step (option 2).
- No left sidebar or split list/detail view (option 3); the admin menu
  (Students · Invoices · Roles · History · More) stays as it is.
- The student's own invoice and coaching pages do not change.

## Anti-goals (a failure even if it works)

- More steps than today to send, record a payment or void. Opening a
  panel replaces scrolling to the form; the action What's next suggests
  starts open, so the usual next step is never behind an extra click.
- Any change to sign-in, the administrator session (Enter/End
  administration), authorization, CSRF, role switching, or the meaning and
  confirmation checkboxes of any money action. Every form keeps its fields,
  POST target and server checks; only where it sits on the page changes.
- Decoration that hides information (status by colour alone, icons without
  text).

## Constraints

- Server-rendered HTML in TS template strings; CSS in `public/style.css`
  (new rules in a `/* #854 */` block). Small same-origin scripts in
  `public/` are allowed by the existing CSP; the page must work without them.
- Panels use native `<details>`. Failure handling is unchanged: a failed
  POST still shows today's error page (with its "Inspect original
  operation" link); empty fields are still stopped by `required`.
- Works at 412px wide with no horizontal scroll; tables stack as the
  existing `.stack-table` does.
- BDD, `make verify`, coverage ≥ 99% per file including branches.

## Approaches considered

1. **New layout only** (chosen): Zoho patterns applied to existing pages, no
   data changes. Low risk, two pull requests.
2. Layout plus data (due dates, payment terms, short numbers, issue from
   draft): more value, changes the database; deferred to its own step.
3. Full Zoho-style app shell (sidebar, split view): most Zoho-like but
   replaces the just-settled menu and is the largest job.

The owner picked 1.

## Design

### Part 1 — Invoices list (`/operator/invoices`)

```
Invoices
┌ Outstanding ─┐ ┌ Unpaid ─┐ ┌ Not sent ┐ ┌ Hours to review ┐
│ CAD 720.00   │ │ 1       │ │ 1        │ │ 1               │
└──────────────┘ └─────────┘ └──────────┘ └─────────────────┘
All (3) · Unpaid (1) · Not sent (1) · Paid (1) · Void (0)
Issued      Number       Student     For                   Amount   Balance  Status
14 Nov 2026 DN-70f95bf4  Mei Tanaka  Coaching · Sep 2026   720.00   720.00   [Unpaid] Not sent
```

- Summary cards are links: Outstanding and Unpaid → `?status=unpaid`,
  Not sent → `?status=not-sent`, Hours to review → the review queue on
  Students (`/operator#awaiting-review`).
- Outstanding = sum of balances (total − paid) of non-void invoices.
- Views via `?status=all|unpaid|not-sent|paid|void` (default all). The
  route's allowed query keys gain `status`; any other value is refused as
  today's invalid queries are. Counts shown next to each view.
- Status badge (text plus colour): Void, Paid, Partially paid, Unpaid,
  Refunded, Partly refunded (today's labels kept). Delivery is a second,
  quieter word with today's labels: Not sent, Sending, Sent, Simulated,
  Unconfirmed (Unconfirmed keeps its warning).
- Views: Unpaid = not void and balance > 0; Not sent = delivery not_sent,
  sending or unconfirmed (as the store counts it today); Paid = not void
  and balance 0, including refunded; Void = voided.
- Counts, Outstanding and the filtered list are computed in SQL across all
  invoices, not from the 100 rows the page loads, so they stay right as
  invoices grow. The list itself keeps its 100-row limit per view.
- The number links to the invoice; the separate "Open" link column goes.
- "Prepare course billing" and "Recurring invoices" move into one closed
  `More actions` area below the table (no behaviour change).

### Part 2 — Invoice page (`/operator/invoices/:id`) and review queue

```
‹ All invoices
Invoice DN-70f95bf4   [Unpaid]  Not sent
[Send] [Record payment] [Print] [More ▾: Record refund · Void]
┌ What's next: not sent yet. Send it to Mei Tanaka.  [Send] ┐
(invoice document, unchanged)
Payments   none yet
Timeline   14 Nov 2026 issued · … sent · … payment CAD x · … voided
```

- Action bar: each button is a `<details>` panel holding the existing form,
  unchanged. The panel for the action What's next suggests starts open;
  What's next's button is a link to that panel (`#send`, `#payment`), not a
  second copy of the form. Buttons appear only when today's page would offer that form
  (same conditions). More holds refund and void.
- Print: a button using a small same-origin script (`window.print()`);
  without script it falls back to today's "use your browser's Print" line.
  Print CSS hides the menu, action bar, What's next and timeline.
- What's next, one line chosen from state: Void → "Voided: reason";
  not sent and email possible → Send; unconfirmed → "Delivery unconfirmed:
  check the recipient's inbox before sending again"; sent/simulated with balance → Record
  payment; paid in full → "Paid in full on <date>"; no email address →
  "No email on file; the student sees it under Invoices", plus Record
  payment if a balance is due.
- Timeline from what the invoice page already loads: issued date, payments
  and refunds with their dates, delivery state without a date ("Sent"; no
  sent timestamp is stored), and "Voided: reason" without a date. The store
  is not changed for the invoice page.
- Review queue on `/operator` (the Students landing's "Awaiting review"):
  a table — Student, Month, Hours, Amount, Submitted — with a "Review"
  link to that month. Approve and issue still happen on the month page,
  whose "Issue the reviewed invoice" panel moves to the top of the main
  column.

## Left to the builder

- Exact badge colours (must meet contrast in light theme; text always
  present), card styling within the existing tokens.
- Whether Hours and Amount in the review queue come from data already
  loaded; if they need a new store query, show Student, Month and Review
  only and note it.
- Test placement and naming, following existing BDD conventions.
