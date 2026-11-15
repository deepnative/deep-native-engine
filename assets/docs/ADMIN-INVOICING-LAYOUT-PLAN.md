# Admin invoicing layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zoho-style admin invoicing: summary cards and status views on Invoices; an invoice page with one action bar, What's next, status badge and timeline; a review-queue table for submitted hours.

**Architecture:** Server-rendered HTML in TS template strings. Part 1 extends `adminOverview` in the store with SQL totals and a status filter and re-renders `/operator/invoices`. Part 2 re-arranges the admin branch of the invoice GET route around the existing forms and turns the Students landing's Awaiting review list into a table. No migration.

**Tech Stack:** TypeScript, Express, PostgreSQL (pg), Vitest (unit, integration), Playwright (e2e).

**Spec:** `assets/docs/ADMIN-INVOICING-LAYOUT.md`

## Global Constraints

- No change to sign-in, the administrator session, authorization, CSRF, role switching, or any form's fields, POST target, confirmation checkbox or server check.
- No migration and no new columns. Failure handling unchanged (failed POSTs still render today's error page).
- The student's invoice and coaching pages render exactly as today.
- New CSS only in a `/* #854 */` block at the end of `public/style.css`.
- Status is always text; colour only reinforces it. Existing labels kept: Void, Paid, Partly paid, Unpaid, Refunded, Partly refunded; delivery Not sent, Sending, Sent, Simulated (sample and sent), Unconfirmed (keeps its warning).
- No horizontal scroll at 412px; tables use `.stack-table`.
- BDD (failing test first); coverage ≥ 99% per file including branches; `make verify` before merge.

## Review Focus

- `?status=` with any value outside `all|unpaid|not-sent|paid|void`, or repeated → refused like today's invalid queries (Task 2 test).
- No invoices at all, or none in a view → cards show CAD 0.00 / 0 and the view says "No unpaid invoices." etc., not an empty table (Task 2 test).
- Unconfirmed delivery → What's next warns to check the inbox and does not open the Send panel by default (Task 4 test).
- Voided invoice → no Send / Record payment / Void buttons; What's next shows "Voided: <reason>"; Print still offered (Task 4 test).
- Student's `/account/purchases/invoices/:id` HTML has no action bar, What's next or timeline (Task 4 test).

---

## Part 1 — branch `codex/invoicing-layout-854`

### Task 1: Store totals and status filter

**Files:**
- Modify: `src/simple-invoice-store.ts` (`adminOverview`, ~1480; `AdminInvoiceRow` type)
- Test: `tests/integration/simple-invoice-summary.test.ts` (new)

**Interfaces:**
- Produces: `export type InvoiceView = "all" | "unpaid" | "not-sent" | "paid" | "void";` and `export const INVOICE_VIEWS: readonly InvoiceView[]`.
- Produces: `adminOverview(token: string, ownerId?: string, view: InvoiceView = "all")` whose value gains `summary: { outstandingCents: number; all: number; unpaid: number; notSent: number; paid: number; void: number; hoursToReview: number }` (all counts across every matching invoice, respecting `ownerId`; not limited to 100) and whose `invoices` rows are filtered by `view` and gain `issuedOn: string` (`document->>'issuedOn'`) and `sample: boolean` (`(document->>'sample')::boolean`).
- Definitions (SQL): unpaid = not voided AND total−paid > 0; not-sent = not voided AND delivery IN ('not_sent','sending','unconfirmed'); paid = not voided AND total−paid ≤ 0; void = voided; outstanding = sum(total−paid) over not voided with total−paid > 0; hoursToReview = count of coaching_months state='submitted'.

- [ ] Step 1: Write failing integration tests `SUMMARY854-01` (seed one unpaid not-sent, one paid sent, one voided invoice; expect `{outstandingCents: <unpaid total>, all: 3, unpaid: 1, notSent: 1, paid: 1, void: 1}`), `SUMMARY854-02` (each view returns only its rows), `SUMMARY854-03` (101 unpaid invoices → `summary.unpaid === 101`, `invoices.length === 100`). Reuse seeding helpers from the existing simple-invoice integration tests.
- [ ] Step 2: Run `npx vitest run --config vitest.integration.config.ts tests/integration/simple-invoice-summary.test.ts` → FAIL.
- [ ] Step 3: Implement in `adminOverview` (one summary query with `count(*) FILTER (...)`; view as a parameterised WHERE fragment chosen from a fixed map, never interpolated input).
- [ ] Step 4: Run again → PASS; run `npm run typecheck`.
- [ ] Step 5: Commit `feat: invoice totals and status views in the store (#854)`.

### Task 2: Invoices list page

**Files:**
- Modify: `src/simple-invoice-routes.ts` (`invoiceRow` ~80, admin list GET ~234)
- Modify: `public/style.css` (`/* #854 */` block)
- Test: `tests/unit/simple-invoice-routes.test.ts`, `tests/e2e/simple-invoices.spec.ts`, `tests/e2e/coaching-invoices.spec.ts` (update expectations of the "Open" link)

**Interfaces:**
- Consumes: Task 1 `InvoiceView`, `INVOICE_VIEWS`, `summary`, `issuedOn`, `sample`.
- Produces: `paymentLabel(row): "Void"|"Paid"|"Partly paid"|"Unpaid"|"Refunded"|"Partly refunded"` and `deliveryLabel(row): string` exported from `src/simple-invoice-routes.ts` for Part 2.

- [ ] Step 1: Failing unit tests `LIST854-01` cards: `<section class="invoice-summary">` with four links — "Outstanding CAD 720.00" → `/operator/invoices?status=unpaid`, "Unpaid 1" → same, "Not sent 1" → `?status=not-sent`, "Hours to review 1" → `/operator#awaiting-review`. `LIST854-02` views nav `<nav aria-label="Invoice views">` with All (3) · Unpaid (1) · Not sent (1) · Paid (1) · Void (1), current one `aria-current="page"`. `LIST854-03` table headers exactly Issued, Number, Student, For, Amount, Balance, Status; Number is the link `/operator/invoices/<id>`; Issued reads "14 Nov 2026"; Status cell `<span class="badge badge-unpaid">Unpaid</span> Not sent`; no "Open" text. `LIST854-04` `?status=bogus` and `?status=unpaid&status=paid` refused. `LIST854-05` empty view says "No unpaid invoices." `LIST854-06` "Prepare course billing" and "Generate due recurring invoices" sit inside one closed `<details class="admin-details"><summary>More actions</summary>`, opened when `ownerId` is given (today's behaviour).
- [ ] Step 2: `npx vitest run tests/unit/simple-invoice-routes.test.ts` → FAIL.
- [ ] Step 3: Implement; add `status` to the route's allowed query keys; CSS for `.invoice-summary` (cards in a wrapping row), `.invoice-views`, `.badge` + `.badge-{void,paid,partly-paid,unpaid,refunded,partly-refunded}` with AA contrast.
- [ ] Step 4: Unit → PASS; `npm run build` then the two e2e specs on desktop and `--project=mobile-chromium` → PASS, no horizontal scroll at 412px.
- [ ] Step 5: Commit `feat: invoices list with summary and status views (#854)`.

## Part 2 — branch `codex/invoicing-page-854` (from origin/main; may run alongside Part 1)

### Task 3: Invoice page action bar, What's next, timeline, print

**Files:**
- Modify: `src/simple-invoice-routes.ts` (admin branch of the invoice GET, ~274–300)
- Create: `public/invoice-print.js` (adds `click` → `window.print()` to `button[data-print]`, reveals it; button `hidden` by default)
- Modify: `public/style.css` (`/* #854 page */` block, incl. `@media print` hiding `.admin-menu, .invoice-actions, .whats-next, .invoice-timeline`)
- Test: `tests/unit/simple-invoice-routes.test.ts`, `tests/e2e/simple-invoices.spec.ts`

**Interfaces:**
- Produces: `whatsNext(i, opts: { canEmail: boolean }): { text: string; open: "send" | "payment" | null }`.

- [ ] Step 1: Failing unit tests `PAGE854-01` header `<h1>Invoice <number></h1>` followed by badge and delivery word, before the document. `PAGE854-02` `<div class="invoice-actions">` with `<details id="send">`, `<details id="payment">`, `<button data-print hidden>Print</button>`, `<details class="more"><summary>More</summary>` holding `id="refund"` and `id="void"` — each present only under today's conditions; forms byte-identical to today's (same fields, actions, checkboxes). `PAGE854-03` What's next: not sent + email → text "Not sent yet. Send it to <name>." with link `#send` and `<details id="send" open>`; sent with balance → "Record a payment when it arrives." + `#payment` open; paid → "Paid in full."; void → "Voided: <reason>." and no send/payment/void; unconfirmed → "Delivery unconfirmed: check the recipient's inbox before sending again." and no panel open; no email → "No email on file; the student sees it under Invoices." `PAGE854-04` timeline `<section class="invoice-timeline">` lists "Issued 14 Nov 2026", each payment/refund with date and amount, delivery state, void reason. `PAGE854-05` student invoice page contains none of `invoice-actions`, `whats-next`, `invoice-timeline`. The "Use your browser's Print command" line stays inside `<noscript>`.
- [ ] Step 2: Run unit → FAIL.
- [ ] Step 3: Implement by reorganising the existing control strings into the panels; add the script tag only on the admin page.
- [ ] Step 4: Unit → PASS; e2e desktop + mobile: open invoice, What's next Send panel open, simulate send, page shows Sent and What's next moves to Record payment; record payment from the panel; void from More.
- [ ] Step 5: Commit `feat: invoice page action bar, what's next and timeline (#854)`.

### Task 4: Review queue table and issue panel first

**Files:**
- Modify: `src/administrator-entry-routes.ts` (`awaitingReview`, ~47)
- Modify: `src/coaching-routes.ts` (admin month page: move the "Issue the reviewed invoice" section to the start of the main column, after the month heading and status)
- Test: `tests/unit/administrator-entry-routes.test.ts`, `tests/unit/coaching-routes.test.ts`

- [ ] Step 1: Failing tests `QUEUE854-01` `#awaiting-review` holds `<table class="member-table stack-table">` with headers Student, Month, Hours, and a "Review" link per row to `/operator/coaching/<id>?month=<month>` (aria-label "Review <name> <month>"); add an Amount column only if `awaiting` already carries it, otherwise not. Empty state unchanged. `QUEUE854-02` on a submitted month, "Issue the reviewed invoice" appears before "Change this student’s hours" and before "Saved periods".
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: run unit + `tests/e2e/coaching-invoices.spec.ts` desktop/mobile → PASS.
- [ ] Step 5: Commit `feat: review queue table, issue panel first (#854)`.

## Finish (each part)

- [ ] `npm run format:check && npm run lint && npm run typecheck && npm run test:unit` clean; coverage ≥ 99% per touched file.
- [ ] Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push; the coordinator gates and merges.
