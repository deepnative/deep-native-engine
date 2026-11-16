# Admin invoicing: due dates, short numbers, issue from a draft (option 2, #856)

Follows [ADMIN-INVOICING-LAYOUT.md](ADMIN-INVOICING-LAYOUT.md) (#854), which
left these three stored-data changes out.

## Intent

The owner (sole administrator) wants the invoicing back office to work like a
professional tool such as Zoho Invoice. #854 fixed the layout. What is still
missing is what an accountant would expect: every invoice says when it is
due, late money is visible, invoice numbers are short and in sequence, and an
administrator can turn a month of hours into an invoice without waiting for
the student to press Submit.

## Goals

1. **Due dates and payment terms.** Every new invoice carries payment terms
   and a due date, printed on the invoice the student sees.
2. **Overdue and aging.** An invoice with a balance after its due date is
   *Overdue*. The admin Invoices page shows it, and splits outstanding money
   by age.
3. **Short sequential numbers.** New invoices are numbered INV-0001, INV-0002
   and so on.
4. **Issue from a draft.** On a draft month, the administrator can issue the
   invoice for the student by giving a reason, and the student sees it.

## Non-goals

- No reminder emails or automatic late fees.
- No settings page. Terms are chosen on each issue form.
- No change to existing invoices: no renumbering and no due dates added
  after the fact.
- No change to the money forms (send, payment, refund, void), sign-in, roles,
  the administrator session, CSRF or deletion.

## Anti-goals (a failure even if it works)

- Any existing unpaid invoice suddenly shows as Overdue on release day.
- An issued invoice's printed number or contents change after issue. The
  database already forbids this (`preserve_simple_invoice_snapshot`), and that
  stays.
- A student finds an invoice for hours they never submitted, with no
  explanation.
- Gaps in the real invoice sequence that come from failed or rolled-back
  issues.

## Constraints

- An issued invoice's `document` jsonb is immutable (migration 082 trigger).
  The number and due date must therefore be written into `document` at the
  moment of issue.
- Dates follow Toronto time (`toronto_today()`, migration 136).
- Repo gate rules: migrations in `migrations/NNN-*.sql`, at least 99% coverage
  per file, BDD tests, no new public scripts.

## Approaches considered

**Numbers**
- A. *Picked:* a gapless counter row, updated inside the issue transaction
  (`UPDATE … SET next = next + 1 RETURNING`). A rolled-back issue consumes no
  number.
- B. A Postgres sequence. Simpler, but rollbacks and retries leave gaps.
  Rejected because of the gaps anti-goal.
- C. Renumber old invoices too. Rejected: their documents are immutable, and
  they have already been sent.

**Due date storage**
- A. *Picked:* `terms` and `dueOn` stored in `document` (printed, immutable),
  with overdue computed in SQL from `document->>'dueOn'`. One source of
  truth, and the data is small.
- B. A separate `due_on` column. Faster to query, but it can drift from the
  printed document. Not needed at this size.

**Issue from a draft**
- A. *Picked (the owner chose this):* the administrator issues from the draft
  with a required reason, recorded and shown to the student, in the same way
  as hour corrections (#832).
- B. Keep student submission mandatory. Rejected by the owner.

## The design

### 1. Payment terms and due date

- **Terms options:** `due_on_receipt` (due date = issue date), `net_15`, and
  `net_30`. The default is **Net 15**.
- **Where terms are chosen:** a "Payment terms" select on each admin issue
  form (reviewed coaching month, issue from draft, coaching terms invoice).
- **Recurring course-billing invoices:** these are issued automatically, so
  there is no form and they use the default (Net 15). *Builder/owner call:*
  this does not change the price the student agreed to; it is only a due date.
- **Stored fields:** `document.terms` and `document.dueOn` (YYYY-MM-DD),
  where `dueOn = issuedOn + days`.
- **Printed invoice:** shows "Payment terms: Net 15" and "Due 1 December
  2026" under Issued. The student's own invoice pages show the due date too.
- **Old invoices:** no `dueOn`. They show "No due date" and are never Overdue.

### 2. Overdue and aging (admin Invoices page)

- **When an invoice is Overdue:** not void, not sample, balance > 0, and
  `dueOn < toronto_today()`.
- **Status badge:** "Overdue" (a new `.badge-overdue`, a warning colour that
  stays readable in dark mode) replaces "Unpaid" on overdue invoices.
- **New view:** *Overdue*, with a count, placed after *Unpaid*. *Unpaid*
  still includes overdue invoices.
- **Summary card:** the Outstanding card gains three lines: "Not yet due",
  "1–30 days overdue" and "Over 30 days overdue". Old invoices with no due
  date count as "Not yet due".
- **Table:** gains a **Due** column (date, or "—"). An overdue row shows "N
  days overdue" in the status cell.
- **Invoice page:** the header shows the due date. "What's next" says
  "Overdue by N days. Record a payment when it arrives." when it applies.

### 3. Short numbers

- **Migration:** creates `simple_invoice_numbers(series text PRIMARY KEY,
  next integer)` with two rows, `real` and `sample`.
- **Real invoices:** get `INV-0001` onward. The format pads to four digits
  and grows past 9999.
- **Sample (not payable) invoices:** get `SAMPLE-0001` onward, so the real
  sequence has no gaps. *My call.*
- **Old invoices:** keep `DN-<uuid>`.
- **Where the number comes from:** all three issue paths (course billing
  `issue()`, `issueCoaching`, `issueCoachingTerms`) take the number from the
  counter in the same transaction.
- **Lists show the document number:** the places that build
  `DN-${id.slice(0,8)}` (the reconciliation view and any other list) show
  `document.number` when it starts with INV-/SAMPLE-, and keep today's short
  DN form for old ones.
- **"Replaces void invoice" line:** this line on replacement coaching
  invoices shows the replaced invoice's document number.

### 4. Issue from a draft

- **Where it appears:** on the admin month page, when the month is `draft`
  and a rate is set, with the hours > 0 and the billing mode matching. The
  page shows **Issue invoice from this draft**.
- **The form contains:**
  - the hours and amount shown
  - Payment terms
  - tax, as on the reviewed path
  - a required "Reason the student did not submit" (1–500 characters)
  - a confirm checkbox: "I issue these hours for the student. They will see
    the hours, the amount and this reason."
- **Store method `issueCoachingFromDraft`:** in one transaction, with an
  idempotent operationId and an expectedRevision check:
  - writes the `coaching_submissions` snapshot (as submit does, but with the
    admin as actor)
  - records the reason in a new table `coaching_admin_issues(owner_id, month,
    revision, reason, actor_id, created_at)`
  - issues the invoice exactly as `issueCoaching` does
  - logs a `billing_change_events` entry `issued_from_draft`
- **The student sees:** on their coaching page for that month, "Your
  administrator issued this invoice from your saved draft on <date>. Reason:
  <reason>". It is also included in Download my records (`member-export.ts`,
  next to the hour corrections).
- **The reviewed-submission path is unchanged** apart from the Payment terms
  select.

## Left to the builder

- **Exact markup and CSS:** follow the #854 patterns (`.badge-*`,
  `.invoice-summary`, the action panels).
- **Code structure:** how to share code between `issueCoaching` and
  `issueCoachingFromDraft`.
- **Test names, and which unit, integration and e2e specs to extend.**
- **Wording,** apart from the lines quoted above.

## Calls settled after the builder check (the owner can override)

1. **The printed invoice says it was issued from a draft.** At issue time,
   `document.coaching.issuedFromDraft = true` is written. The invoice then
   prints "Issued by the administrator from the student's saved hours." The
   reason is not printed on the invoice. It appears only on the student's
   coaching page and in Download my records.
2. **No issuing from a draft before the period ends.** A draft can be issued
   only after its period has ended: for a calendar month, after the month's
   last day; for a defined period, after `periodEnd`, as today. This stops
   the administrator from locking a month the student is still filling in.
3. **Unsent invoices are never Overdue.** An invoice whose delivery is
   `not_sent` or `unconfirmed` stays in the "Not sent" view and counts as
   "Not yet due" in the aging lines. The due date is still printed and still
   counts from the issue date.
4. **New invoices are dated in Toronto time.** New invoices take `issuedOn`
   from `toronto_today()` instead of the UTC date, so an evening issue is not
   dated tomorrow. Old invoices are unchanged. The retention year follows the
   printed date, which is correct.
5. **Small details:**
   - The counter seed is idempotent (`ON CONFLICT DO NOTHING`).
   - The `billing_change_events` action CHECK is extended with
     `issued_from_draft`.
   - Sample invoices are excluded from aging, as they already are from
     Outstanding.
