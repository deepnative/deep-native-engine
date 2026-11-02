# Private billing recipient and course proposal return

Open **My account → Billing recipient** to save a recipient name and email. These fields are private to the current member and never replace the verified sign-in email. No card, CVV, bank credential, payment preference machinery or provider is collected. Saving a profile creates no charge, enrollment or agreement, and remains available while invoicing is disabled.

Course proposals suggest the saved recipient; the learner can edit it before explicitly accepting the displayed courses, published versions, CAD amounts, tax, one-time/monthly cadence and start date. Acceptance snapshots those submitted details through the existing invoice engine. Profile changes never rewrite accepted invoices, recurring agreement recipients or already saved/submitted coaching drafts. New coaching months suggest the same profile without changing a saved month. Payment, invoice and learning/access state remain separate; sample invoices are not payable and do not grant paid service.

The **Reopen this proposal after sign-in** link remembers only a proposal UUID in an authenticated, HttpOnly,15-minute selection cookie. It exposes no proposal contents before account authorization. Existing registration and verified-email recovery return to that selection; account creation does not transfer another member’s proposal. Reopen the link after signing in when the cookie expires or another device is used, or inspect Courses and invoices from My account. Existing public program selection/confirmation remains unchanged.

Recipient edits use a revision and the existing member→workspace lifetime/erasure fences. Two concurrent edits cannot silently overwrite one another. Validation or stale forms retain attempted text with a recovery message. An uncertain storage response is not proof of a save: inspect the current profile before another action. Current member token, origin and CSRF protect writes; unknown fields/owner IDs are rejected. No administrator recipient editor was needed for this bounded member outcome.

Migration086 creates only the member-owned billing_profiles table with cascade erasure. Private export v30 appends section55 after all existing sections; previous cursor section identities remain stable. Learning-account removal erases the reusable profile. Existing issued financial history follows its separate sample/configured retention policy; profile edits/deletion do not silently change financial history.

## Acceptance mapping

| Stable scenario | Executable evidence |
| --- | --- |
| BILLPROFILE01 selection/ordinary same-account recovery, no implied purchase | invoice-selection units; L280 desktop/mobile; retained public-program registration/confirmation cases |
| BILLPROFILE02 private validation/revision/isolation/export/deletion | billing-profile and invoice route units; simple-invoices real PostgreSQL tests and member-export/study-unit export cases; L280 |
| BILLPROFILE03 exact explicit confirmation and immutable snapshots | existing invoice acceptance/idempotency/stale-source tests plus new one-time/monthly native snapshot/profile tests; coaching route units; L280 |
| BILLPROFILE04 honest sample/pending/cancel/recovery and retained work | existing invoice operation/failure tests and account states; profile uncertainty/validation units; L280 cancellation and retained private work |

Original missing profile route failed expected200/actual404 before implementation. Existing identity/invoice/program behavior is reused with honest passing baselines. L280 appends one critical case: v131,277local scenarios276critical,554primary desktop/mobile executions; all prior IDs, full-MVP/provisional inventories and thresholds remain unchanged. Actual exact-revision proof, review, merge/source readback, dedicated demo and hosted verification are recorded on #571; this document alone does not assert deployment, full-MVP or qualified commercial acceptance.
