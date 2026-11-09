# Private billing recipient and course proposal return

Open **My account → Billing recipient** to save a recipient name and email. These fields are private to the current member and never replace the verified sign-in email. No card, CVV, bank credential, payment preference machinery or provider is collected. Saving a profile creates no charge, enrollment or agreement, and remains available while invoicing is disabled.

Course proposals suggest the saved recipient; the learner can edit it before explicitly accepting the displayed courses, published versions, CAD amounts, tax, one-time/monthly cadence and start date. Acceptance snapshots those submitted details through the existing invoice engine. Profile changes never rewrite accepted invoices, recurring agreement recipients or already saved/submitted coaching drafts. New coaching months suggest the same profile without changing a saved month. Payment, invoice and learning/access state remain separate; sample invoices are not payable and do not grant paid service.

The **Reopen this proposal after sign-in** link remembers only a proposal UUID in an authenticated, HttpOnly,15-minute selection cookie. It exposes no proposal contents before account authorization. Existing registration and verified-email recovery return to that selection; account creation does not transfer another member’s proposal. Reopen the link after signing in when the cookie expires or another device is used, or inspect Courses and invoices from My account. Existing public program selection/confirmation remains unchanged.

Recipient edits use a revision and the existing member→workspace lifetime/erasure fences. Two concurrent edits cannot silently overwrite one another. Validation or stale forms retain attempted text with a recovery message. An uncertain storage response is not proof of a save: inspect the current profile before another action. Current member token, origin and CSRF protect writes; unknown fields/owner IDs are rejected. No administrator recipient editor was needed for this bounded member outcome.

Migration086 creates only the member-owned billing_profiles table with cascade erasure. Private export v30 appends section55 after all existing sections; previous cursor section identities remain stable. Learning-account removal erases the reusable profile. Existing issued financial history follows its separate sample/configured retention policy; profile edits/deletion do not silently change financial history.

## Registered-name default, coaching edits and company name (#796)

- **Default before a recipient is saved.** Billing recipient, coaching months and course proposals suggest the member's registered display name.
  - The email starts empty: the verified sign-in email is stored only as a hash (see [account types](ACCOUNT-TYPES.md)), so it cannot be suggested without a separate privacy decision.
  - A saved recipient always wins over the default.
- **Coaching edits become the reusable recipient.** Saving a coaching draft also saves its name, email and company as the reusable billing recipient.
  - This happens in the same transaction as the draft.
  - The revision moves only when a value changed, so an open Billing recipient form reports the edit as a conflict instead of overwriting it.
  - The sign-in email, sessions and other drafts never change.
- **Optional company name.** Billing recipient, coaching months and course acceptance have an optional **Company name**: one line, up to 200 characters, blank meaning none.
  - It is snapshotted with a coaching submission and a course acceptance.
  - It is printed under **Bill to** on the invoice and in invoice email text only when set.
  - Issued invoices and earlier snapshots never change.
- **Migration and export.** Migration 126 adds nullable company columns to `billing_profiles`, `coaching_months` and `simple_invoice_plans` (`recipient_company`). The private export includes them in the existing billing profile, coaching month and course agreement sections.

| Scenario                                           | Executable evidence                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| RECIPIENT-01 registered name until saved           | billing-profile and route units; coaching-invoices PostgreSQL; L280                      |
| RECIPIENT-02 saved recipient wins                  | billing-profile and coaching route units; coaching-invoices PostgreSQL; L280             |
| RECIPIENT-03 coaching edits saved for later months | coaching-store unit; coaching-invoices PostgreSQL; L280                                  |
| RECIPIENT-04 optional company validation           | simple-invoice-values, billing-profile and route units; simple-invoices PostgreSQL; L280 |
| RECIPIENT-05 company on the invoice                | views, email, coaching-store and simple-invoice-store units; both PostgreSQL files; L280 |

## Acceptance mapping

| Stable scenario                                                             | Executable evidence                                                                                                                            |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| BILLPROFILE01 selection/ordinary same-account recovery, no implied purchase | invoice-selection units; L280 desktop/mobile; retained public-program registration/confirmation cases                                          |
| BILLPROFILE02 private validation/revision/isolation/export/deletion         | billing-profile and invoice route units; simple-invoices real PostgreSQL tests and member-export/study-unit export cases; L280                 |
| BILLPROFILE03 exact explicit confirmation and immutable snapshots           | existing invoice acceptance/idempotency/stale-source tests plus new one-time/monthly native snapshot/profile tests; coaching route units; L280 |
| BILLPROFILE04 honest sample/pending/cancel/recovery and retained work       | existing invoice operation/failure tests and account states; profile uncertainty/validation units; L280 cancellation and retained private work |

Original missing profile route failed expected200/actual404 before implementation. Existing identity/invoice/program behavior is reused with honest passing baselines. L280 appends one critical case: v131,277local scenarios276critical,554primary desktop/mobile executions; all prior IDs, full-MVP/provisional inventories and thresholds remain unchanged. Actual exact-revision proof, review, merge/source readback, dedicated demo and hosted verification are recorded on #571; this document alone does not assert deployment, full-MVP or qualified commercial acceptance.

BILLPROFILE05 checks the actual migration inventory and ordinary rerun preservation: admission migration085 and billing migration086 record their own markers with idempotent inserts, while the same account and recipient remain readable. This corrects the inherited missing085 marker and the unpublished billing migration's renumbered marker; no table, row, constraint, retained invoice or staff authority is reset. Earlier deployed preservation evidence truthfully records the previous marker84.
