# Individual course invoices

Students register through the existing learning page. Registration itself creates no bill. In **My account**, the student can see their account reference and open **Courses and invoices**. Give that reference to course support when arranging a course bundle.

A current platform administrator opens **Staff tools → Course billing and invoices**, selects that registered account, selects the exact published course items and their versions, enters each price and the tax amount, and chooses one-time or monthly billing. This prepares a proposal; it does not issue an invoice or silently change any enrolment, saved learning or access.

The student reviews the complete proposal, issuer, instructions, total and schedule, supplies the individual billing name/email, and explicitly accepts. A proposal can be accepted only until its start date, judged on the database's UTC date. After that its page says acceptance has closed, a direct acceptance is refused, and nothing is billed for the months already past. Staff prepare a new proposal if the student still wants the courses. The resulting private invoice lists the accepted course items and amounts. Its immutable snapshot survives later source/profile/settings changes. Use the browser’s **Print → Save as PDF** to save it. Staff confirms actual received offline funds against that invoice; a student claim or partial payment is not full settlement. Offline records do not grant coaching, qualifications or mark a course complete.

## One-time and recurring billing

One-time terms create exactly one invoice. Monthly terms create a separate invoice for each calendar period, anchored to the accepted starting day with month-end clipping. January31 → February28 → March31 does not drift. Monthly invoices do not debit a card or bank account.

The running application processes due accepted agreements in its existing bounded background loop, independently of browser activity. Expiring or signing out of a browser does not cancel an accepted recurring agreement. The owning student’s **Cancel future billing** stops new invoices; account deletion also stops future processing. Already issued invoices remain distinct. Only one monthly agreement can be active for a student; cancel it explicitly before accepting replacement terms. Changed course or price terms require a new proposal and acceptance; an old invoice is never rewritten. Retired or newly ineligible source items stop new issuance pending staff investigation.

A finite current platform administrator can also explicitly generate due invoices. Unique agreement/period records and original-operation receipts prevent duplicate invoices and offline payments. If an operation is unconfirmed, inspect its original receipt and current invoice before another action; do not replace its operation key or treat a missing receipt as proof of rollback.

## Manual receipts and refunds

Offline funds and refunds are separate, append-only events with server actor and time, event date, a required evidence reference and the fixed status `manual_unverified`. The invoice shows them as a **Payment record** labelled "Recorded manually by staff. Not verified by a payment provider." The member sees amount, date and reference, and the export adds them as `invoicePayments` (section 60, `local-member-records-v39`); only staff see who recorded each entry. The reference rejects card-like digit runs, and it must not hold bank credentials.

**Record offline refund** records money already returned. It moves no money. The recorded payment stays, the status reads **Partly refunded** or **Refunded**, the balance does not reopen and the course agreement is unchanged. A mistyped receipt has no correction path yet. A real provider and its reconciliation are not implemented: see [#32](https://github.com/deepnative/deep-native-engine/issues/32).

## Signed test events (local only)

`DNE_TEST_PROVIDER_EVENTS=enabled` with `DNE_TEST_PROVIDER_EVENT_KEY` (an invented key of 32 or more characters) and `DNE_INVOICE_MODE=sample` adds `POST /test-provider/invoice-events`. It is off by default, and a hosted site, including the demo site, refuses to start with it on. No provider, account or money is involved, and this format is not a real provider's contract.

The `X-DNE-Test-Signature` header is `sha256=` followed by the hex HMAC-SHA256 of the raw body. The body has exactly `id`, `type` (`payment.succeeded`, `payment.failed` or `refund.succeeded`), `invoiceId`, `paymentRef`, `amountCents` and `occurredAt`. A bad signature gets 401 before anything is read, and a real invoice gets 404.

- Each event becomes an immutable row in the same event table, with the fixed status `signed_test_event` and no staff actor. Repeating an ID does nothing; reusing it with different content gets 409.
- A failure never moves money, so a stale failure can't undo a payment and never reads as a refund.
- A refund that arrives before its payment is held, then applied once when the payment arrives. A payment on a void invoice, above the balance or repeated under a new ID is held with no money moved. Held events are shown as **Test event not applied** and stay held.
- Events change only the invoice record. They grant no access or entitlement and don't change the agreement. A return address or redirect does nothing.
- The invoice labels these entries as simulated, and staff change history lists them as signed test events, not as a staff member's act.

## Corrections and correspondence

For an unpaid incorrect invoice, staff records a reason and chooses **Void unpaid invoice**, then prepares a corrected proposal. The original document remains visible as void, with no payment due. Voiding does not cancel the underlying course agreement. Invoices with recorded money or an uncertain in-flight email cannot be voided through this flow; refunds and paid-accounting adjustments are not implemented.

Invoice email uses a separate message from sign-in email, through the already configured Azure sender. It links to the individual’s authenticated account; no bearer token appears in the link. A successful provider result is not proof of inbox receipt. A failed or unknown send is retained as unconfirmed and is not automatically sent again. An administrator’s expired authority does not silently renew itself to finish an email operation.

## Configuration and local samples

Invoicing is disabled by default. Existing learning remains available.

- `DNE_INVOICE_MODE=sample` permits only an isolated local preview. Every document is labelled **SAMPLE · NOT PAYABLE**; issuer, money and tax are invented. Email delivery is simulated. Do not pay or enter real payment details.
- `DNE_INVOICE_MODE=configured` requires `DNE_INVOICE_ISSUER`, `DNE_INVOICE_PAYMENT_INSTRUCTIONS` and explicit `DNE_INVOICE_CURRENCY=CAD`. Use the actual issuer and its approved tax/payment facts. No real values are supplied by this implementation. The first version supports CAD cents and monthly recurrence only.
- The hosted engine runs configured mode as Deep Native Inc. with Interac e-Transfer instructions, under the owner's 3 November 2026 authorization ([#624](https://github.com/deepnative/deep-native-engine/issues/624)). The values live in `scripts/azure-release.py` and are applied by every release.
- Sending real invoice correspondence additionally requires the existing configured hosted email service. Configuration, deployment, provider confirmation and recipient receipt are separate evidence.

Student invoice access requires the existing current member session; staff billing actions require the current platform-admin role. Sample invoices follow account erasure. Configured issued financial records are retained after account deletion, unlinked from the deleted learning identity and accessible only to an authorized billing administrator. This is a technical retention distinction, not a legally approved retention duration. Own structured export includes issued invoice documents alongside the appended coaching rate/month/submission sections, and, from `local-member-records-v39`, the member's own offered, accepted and cancelled course-billing agreements as `invoicePlans` (section 62), with their terms, acceptance and recipient but not the preparing staff member. The authenticated printable invoice remains available. Optional [monthly coaching hours](MONTHLY-COACHING-INVOICES.md) reuse this invoice system with an explicit quantity/rate snapshot; they are separate from fixed monthly course recurrence.

Lists currently show the newest100 records; older invoices remain directly accessible by their retained reference. The staff student picker shows100 account references. Broader pagination and paid-invoice adjustments remain limitations, not an automatic launch authorization.

BDD contract: OFFPUR01–10 on issue557. Native tests cover atomic issuance/replay, concurrent payment, recurring periods/cancellation, expired browser privacy, account erasure/retention and a committed transaction with a lost acknowledgement. Browser scenarios L266–L268 cover desktop/mobile course consolidation, private print/payment, explicit monthly cancellation and unpaid correction. These specifications do not establish completed delivery; consult the issue’s exact revision and verification evidence.
