# Invoicing terms, overdue, short numbers, issue from draft — Implementation Plan (#856)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add payment terms and due dates, overdue and aging, gapless INV-/SAMPLE- numbers, and admin issue from a draft to the existing invoicing.

**Architecture:**
- Numbers, terms and `dueOn` are written into the immutable `document` jsonb at issue time, from a counter row locked in the same transaction.
- Overdue is computed in SQL from `document->>'dueOn'`, `delivery` and `toronto_today()`.
- Issue from a draft is a new store method that writes the submission snapshot and a reason row, then runs the shared coaching issue path.

**Tech Stack:** Express server-rendered TS, Postgres, node:test unit and integration tests, Playwright e2e.

**Spec:** `assets/docs/ADMIN-INVOICING-TERMS.md`. Read it first. Its "Calls settled after the builder check" section is binding.

## Global Constraints

- **Terms values:** `due_on_receipt` (0 days), `net_15` (15), `net_30` (30). The default is `net_15`. Labels are "Due on receipt", "Net 15" and "Net 30".
- **Number format:** `INV-` or `SAMPLE-`, then the number zero-padded to 4 digits (`INV-0001`, `INV-12345`). Real and sample have separate series. There are no gaps on rollback.
- **Dates:** new invoices' `issuedOn = toronto_today()`. `dueOn = issuedOn + days`. Old invoices are unchanged and have no `dueOn`.
- **Overdue:** `void_reason IS NULL AND NOT sample AND total-paid>0 AND delivery='sent' AND (document->>'dueOn')::date < toronto_today()`.
- **Aging lines:**
  - "Not yet due": every other unpaid invoice that isn't a sample, including ones with no due date and unsent ones.
  - "1–30 days overdue"
  - "Over 30 days overdue"
- **Issue from a draft:**
  - Allowed only on a `draft` month with rate set and minutes > 0.
  - The sample setting must equal the current one.
  - The period must have ended: a calendar month after its last day (Toronto), a defined period after `periodEnd`.
  - The reason is 1–500 characters after trim.
- **The printed line, exact:** "Issued by the administrator from the student's saved hours." The reason is not printed.
- **The student's notice, exact:** "Your administrator issued this invoice from your saved draft on <day label>. Reason: <reason>"
- **Do NOT change:**
  - authentication, administrator session (Enter/End administration), authorization, CSRF, role switching, sign-in/out, password, email verification or deletion behaviour
  - `infra/`
  - the send, payment, refund or void forms
- **Scope check:** only the allowed repo paths. No new `public/*.js`. CSS goes in a `/* #856 */` block in `public/style.css`. No `display:none` after the phone-table rules (#844 test).
- **Coverage:** at least 99% per file, including branches. BDD scenario IDs go in the test names (prefix `TERMS856-NN`).

## Review Focus

1. Two administrators issue at the same moment: the numbers must be distinct and consecutive. Lock the counter row with `UPDATE … RETURNING`. Add an integration test that runs two concurrent issues.
2. A retried operationId (double submit) must return the same invoice and number, and must not use up a second number. Add an integration test.
3. An issue that fails after the number is allocated (for example the amount-limit check) must leave the counter unchanged. Add an integration test.
4. An old `DN-` invoice with no `dueOn` must show "No due date", be excluded from Overdue, and count as "Not yet due". Add an integration test and a unit test.
5. Issuing a draft whose period has not ended must be refused with `conflict`, and the form must not render. Add an integration test and a route unit test.

---

### Task 1: Migration, number counter, Toronto date, terms on all issue paths

**Files:**
- Create: `migrations/142-invoice-terms-numbers.sql`
- Modify: `src/simple-invoice-store.ts`: `issue()` (~l.357), `issueCoaching`, `issueCoachingTerms`, `utcToday` callers that set `issuedOn`
- Modify: `src/simple-invoice-views.ts`: `SimpleInvoiceDocument`
- Test: `tests/integration/simple-invoice-terms.test.ts` (new)

**Interfaces:**
- **Produces:**
  - `export type PaymentTerms = "due_on_receipt"|"net_15"|"net_30"`
  - `export const PAYMENT_TERMS: Record<PaymentTerms,{days:number;label:string}>`, in `simple-invoice-views.ts`
  - `SimpleInvoiceDocument` gains `terms?: PaymentTerms; dueOn?: string`
  - `coaching` gains `issuedFromDraft?: true`
  - `issueCoaching` and `issueCoachingTerms` input gains `terms?: PaymentTerms`, default `net_15`. Any other value → `invalid`.
  - Private helper `nextNumber(tx, sample:boolean): Promise<string>`

- [ ] **Step 1: Write the migration.**
  - `CREATE TABLE IF NOT EXISTS simple_invoice_numbers(series text PRIMARY KEY CHECK(series IN ('real','sample')), next integer NOT NULL CHECK(next>0))`
  - Seed both rows with `next=1`, `ON CONFLICT DO NOTHING`. Migrations re-run at every start.
  - Extend the `billing_change_events` action CHECK with `'issued_from_draft'`. Copy the latest list (from migration 140 or 141, whichever is newer) and add the new value.
- [ ] **Step 2: Write the failing integration tests.**
  - `TERMS856-01 new coaching invoice is INV-0001 then INV-0002, dated Toronto today, Net 15 dueOn = +15d`
  - `TERMS856-02 sample invoices use SAMPLE-0001`
  - `TERMS856-03 due_on_receipt dueOn = issuedOn; net_30 = +30`
  - `TERMS856-04 unknown terms → invalid`
  - `TERMS856-05 retried operationId returns the same number; counter unchanged`
  - `TERMS856-06 failed issue leaves the counter unchanged`
  - `TERMS856-07 concurrent issues get distinct consecutive numbers`
  - `TERMS856-08 recurring course-billing invoice gets INV number and net_15`
- [ ] **Step 3: Run the tests to confirm they fail.** Use the test-DB recipe in the `tests/integration` README/support. The DB name must be `dne_test_<32hex>`.
- [ ] **Step 4: Implement.**
  - Implement `nextNumber`, and replace every `DN-${id}` number with it.
  - Set `issuedOn` from `to_char(toronto_today(),'YYYY-MM-DD')` on the issue paths only.
  - Add `terms` and `dueOn` to the document.
- [ ] **Step 5: Run the tests, then update the existing tests that assert `DN-` numbers or UTC issue dates for new invoices.**
- [ ] **Step 6: Commit.**

### Task 2: Printed invoice and student pages

**Files:**
- Modify: `src/simple-invoice-views.ts`: the document render (~l.97)
- Test: `tests/unit/simple-invoice-views*.test.ts` (extend the existing spec)

- [ ] **Step 1: Write the failing unit tests.**
  - `TERMS856-10`: the line "Payment terms: Net 15" and the line "Due <day label>" render under Issued.
  - `TERMS856-11`: a document with no `terms` shows neither line.
  - `TERMS856-12`: with `coaching.issuedFromDraft`, the exact printed line from Global Constraints renders.
  - `TERMS856-13`: the "Replaces void invoice" line shows the replaced invoice's document number when the store supplies one. Otherwise it keeps the `DN-<id>` text.
- [ ] **Step 2: Implement, then run the tests.** For the replaced number, add an optional `replacesNumber?: string` on the view input. Do not change the stored document.
- [ ] **Step 3: Commit.**

### Task 3: Overdue and aging on the admin Invoices list and invoice page

**Files:**
- Modify: `src/simple-invoice-store.ts`: `InvoiceView`, `INVOICE_VIEWS`, `VIEW_SQL`, `InvoiceSummary`, `AdminInvoiceRow`, `adminOverview`
- Modify: `src/simple-invoice-routes.ts`: the list page, the invoice page header and `whatsNext`
- Modify: `public/style.css`: `/* #856 */` with `.badge-overdue`, light and dark
- Test: `tests/integration/simple-invoice-summary.test.ts`, the route unit tests

**Interfaces:**
- `InvoiceView` adds `"overdue"`. In `INVOICE_VIEWS` it goes after `"unpaid"`.
- `InvoiceSummary` adds `overdue:number; notYetDueCents:number; overdue1to30Cents:number; overdueOver30Cents:number`.
- `AdminInvoiceRow` adds `dueOn:string|null; overdueDays:number|null`.

- [ ] **Step 1: Write the failing tests.**
  - `TERMS856-20`: the summary buckets with invoices at 0, 10 and 40 days overdue, plus one unsent and one old with no due date.
  - `TERMS856-21`: the overdue view filters.
  - `TERMS856-22`: unsent is never overdue.
  - `TERMS856-23`: the list shows the Due column, "—" for old invoices, and the "Overdue" badge plus "N days overdue".
  - `TERMS856-24`: the invoice page header shows the due date, and What's next shows the overdue sentence: "Overdue by N days. Record a payment when it arrives."
- [ ] **Step 2: Implement.** Compute overdue in SQL using the Global Constraints expression.
- [ ] **Step 3: Run the tests, then commit.**

### Task 4: Payment terms select on admin issue forms

**Files:**
- Modify: `src/coaching-routes.ts`: the "Issue the reviewed invoice" form and its POST
- Modify: the coaching-terms issue route/form (find `issueCoachingTerms` callers)
- Test: the route unit tests and the e2e spec that issues a coaching invoice

- [ ] **Step 1: Write the failing tests.**
  - `TERMS856-30`: the issue form has `<select name="terms">` with the 3 options, Net 15 selected.
  - `TERMS856-31`: the POST passes `terms` through, and an invalid value → 400 or re-render with an error, as the existing invalid path does.
- [ ] **Step 2: Implement, then run the tests, then commit.**

### Task 5: Issue from a draft

**Files:**
- Modify: `migrations/142-invoice-terms-numbers.sql`: add `coaching_admin_issues(owner_id uuid REFERENCES learners(id) ON DELETE CASCADE, month text, revision integer, reason text CHECK(length(btrim(reason)) BETWEEN 1 AND 500), actor_id uuid REFERENCES principals(id) ON DELETE SET NULL, created_at timestamptz DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,month,revision))`
- Modify: `src/simple-invoice-store.ts`: new `issueCoachingFromDraft`; `coachingOverview` returns the admin issues for the student
- Modify: `src/coaching-routes.ts`: the admin form on a draft month, the POST `${base}/issue-draft`, the student notice
- Modify: `src/member-export.ts`: include `coaching_admin_issues` next to `coaching_hours_overrides` (~l.754)
- Test: `tests/integration/coaching-issue-from-draft.test.ts` (new), the route unit tests, one e2e scenario

**Interfaces:**
- `issueCoachingFromDraft(token, {ownerId, month, expectedRevision, taxCents?, terms?, reason, operationId}): Promise<InvoiceResult<{invoiceId:string}>>`
  - It is admin-only through `run(token, true, …)`.
  - It writes the `coaching_submissions` snapshot with the student's name and email and the current rate.
  - It sets the month to submitted at revision+1, inserts the `coaching_admin_issues` row, and logs `issued_from_draft`.
  - It then shares the issue body with `issueCoaching`. Extract a private function and pass `issuedFromDraft: true`.
- The `SavedCoachingMonth` (or overview) gains `adminIssue?: {reason:string; on:string}`.

- [ ] **Step 1: Write the failing tests.**
  - `TERMS856-40`: an admin issues an ended draft month and gets an invoice with `issuedFromDraft`, and the month is invoiced.
  - `TERMS856-41`: a period that has not ended → conflict.
  - `TERMS856-42`: an empty or 501-character reason → invalid.
  - `TERMS856-43`: a stale revision → conflict.
  - `TERMS856-44`: a non-admin token → denied.
  - `TERMS856-45`: the student's coaching page shows the exact notice.
  - `TERMS856-46`: Download my records includes the reason.
  - `TERMS856-47`: the admin page shows the "Issue invoice from this draft" form only when its conditions hold. The form has the reason field, the terms select and this confirm text: "I issue these hours for the student. They will see the hours, the amount and this reason."
- [ ] **Step 2: Implement, run the tests, then commit.**

### Task 6: Number display in lists

**Files:**
- Modify: `src/invoice-reconciliation-views.ts:228`, and any other place that builds `DN-${…slice(0, 8)}`. Find them with `grep -rn 'DN-\${' src`.
- Test: the existing reconciliation unit test

- [ ] **Step 1: Write a failing test.** Show `document.number` when it matches `^(INV|SAMPLE)-`, and keep the short DN form otherwise. The store must expose `number` on the row.
- [ ] **Step 2: Implement, run the tests, then commit.**

### Task 7: Full local gate

- [ ] Run `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`, then the touched integration and e2e specs. Fix the coverage of every touched file to at least 99%.
- [ ] Do not run `make verify`. The coordinator runs the single shared gate.
