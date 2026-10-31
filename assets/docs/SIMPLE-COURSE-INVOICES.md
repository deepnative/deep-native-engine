# Individual course invoices

Students register through the existing learning page. Registration itself creates no bill. In **My account**, the student can see their account reference and open **Courses and invoices**. Give that reference to course support when arranging a course bundle.

A current platform administrator opens **Staff tools → Course billing and invoices**, selects that registered account, selects the exact published course items and their versions, enters each price and the tax amount, and chooses one-time or monthly billing. This prepares a proposal; it does not issue an invoice or silently change any enrolment, saved learning or access.

The student reviews the complete proposal, issuer, instructions, total and schedule, supplies the individual billing name/email, and explicitly accepts. The resulting private invoice lists the accepted course items and amounts. Its immutable snapshot survives later source/profile/settings changes. Use the browser’s **Print → Save as PDF** to save it. Staff confirms actual received offline funds against that invoice; a student claim or partial payment is not full settlement. Offline records do not grant coaching, qualifications or mark a course complete.

## One-time and recurring billing

One-time terms create exactly one invoice. Monthly terms create a separate invoice for each calendar period, anchored to the accepted starting day with month-end clipping. January31 → February28 → March31 does not drift. Monthly invoices do not debit a card or bank account.

The running application processes due accepted agreements in its existing bounded background loop, independently of browser activity. Expiring or signing out of a browser does not cancel an accepted recurring agreement. The owning student’s **Cancel future billing** stops new invoices; account deletion also stops future processing. Already issued invoices remain distinct. Only one monthly agreement can be active for a student; cancel it explicitly before accepting replacement terms. Changed course or price terms require a new proposal and acceptance; an old invoice is never rewritten. Retired or newly ineligible source items stop new issuance pending staff investigation.

A finite current platform administrator can also explicitly generate due invoices. Unique agreement/period records and original-operation receipts prevent duplicate invoices and offline payments. If an operation is unconfirmed, inspect its original receipt and current invoice before another action; do not replace its operation key or treat a missing receipt as proof of rollback.

## Corrections and correspondence

For an unpaid incorrect invoice, staff records a reason and chooses **Void unpaid invoice**, then prepares a corrected proposal. The original document remains visible as void, with no payment due. Voiding does not cancel the underlying course agreement. Invoices with recorded money or an uncertain in-flight email cannot be voided through this flow; refunds and paid-accounting adjustments are not implemented.

Invoice email uses a separate message from sign-in email, through the already configured Azure sender. It links to the individual’s authenticated account; no bearer token appears in the link. A successful provider result is not proof of inbox receipt. A failed or unknown send is retained as unconfirmed and is not automatically sent again. An administrator’s expired authority does not silently renew itself to finish an email operation.

## Configuration and local samples

Invoicing is disabled by default. Existing learning remains available.

- `DNE_INVOICE_MODE=sample` permits only an isolated local preview. Every document is labelled **SAMPLE · NOT PAYABLE**; issuer, money and tax are invented. Email delivery is simulated. Do not pay or enter real payment details.
- `DNE_INVOICE_MODE=configured` requires `DNE_INVOICE_ISSUER`, `DNE_INVOICE_PAYMENT_INSTRUCTIONS` and explicit `DNE_INVOICE_CURRENCY=CAD`. Use the actual issuer and its approved tax/payment facts. No real values are supplied by this implementation. The first version supports CAD cents and monthly recurrence only.
- Sending real invoice correspondence additionally requires the existing configured hosted email service. Configuration, deployment, provider confirmation and recipient receipt are separate evidence.

Student invoice access requires the existing current member session; staff billing actions require the current platform-admin role. Sample invoices follow account erasure. Configured issued financial records are retained after account deletion, unlinked from the deleted learning identity and accessible only to an authorized billing administrator. This is a technical retention distinction, not a legally approved retention duration. Invoice records are separate from the general learning export; use the owned authenticated invoice’s printable copy.

Lists currently show the newest100 records; older invoices remain directly accessible by their retained reference. The staff student picker shows100 account references. Broader pagination and paid-invoice adjustments remain limitations, not an automatic launch authorization.

BDD contract: OFFPUR01–10 on issue557. Native tests cover atomic issuance/replay, concurrent payment, recurring periods/cancellation, expired browser privacy, account erasure/retention and a committed transaction with a lost acknowledgement. Browser scenarios L266–L268 cover desktop/mobile course consolidation, private print/payment, explicit monthly cancellation and unpaid correction. These specifications do not establish completed delivery; consult the issue’s exact revision and verification evidence.
