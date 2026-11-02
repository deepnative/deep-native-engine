# Monthly coaching hours and individual invoices

Issue [#576](https://github.com/deepnative/deep-native-engine/issues/576) adds one optional journey: register or recover the same learning account, let a current verified administrator set its agreed hourly rate, save and submit a calendar month's coaching duration, then let the administrator review and issue one private invoice. Registration, rate assignment and submission take no payment and grant no paid entitlement. The existing [course invoice system](SIMPLE-COURSE-INVOICES.md) owns the documents, payment records, printing, unpaid voids and operation recovery.

## Member and administrator actions

From **My account → Monthly coaching hours**, select a current or past UTC calendar month. Save whole hours and additional minutes, plus the individual invoice name/email. Reload to inspect the saved draft. The page shows the applicable rate and version and the subtotal before separately supplied tax. Confirm the exact saved draft to submit. The billing email does not change login identity; existing verified-email attachment/recovery restores the same account and its records.

From **Administration → Monthly coaching**, select the member reference. Set a positive CAD hourly rate and an effective month; later months inherit it until another effective rate applies. Future effective rates are allowed, future reported hours are not. Review the pending month, explicitly enter tax and choose **Issue coaching invoice**. The same invoice appears under the member's **Courses and invoices**, with browser Print/Save as PDF. Two invented examples are 90 minutes at CAD120/hour = CAD180 and 90 minutes at CAD80/hour = CAD120, before tax. These examples are not real prices.

Drafts have optimistic revisions. Submission freezes its duration, exact rate/version, recipient, rounded subtotal and sample/configured mode. A changed rate or stale form requires reopening and explicit confirmation. A later rate change never rewrites a submitted or issued snapshot. A sample submission cannot become payable after a configured-mode restart: issuance refuses the mismatch until the month is returned and the member explicitly resubmits in the new mode.

Zero hours remains distinguishable from no submission. Zero hours and a positive duration that rounds to zero are retained as submitted records with no invoice, even if tax is supplied. Minutes must fit the selected calendar month, including leap February. Amounts use whole cents, `floor((minutes × hourlyRateCents + 30) / 60)` once at the subtotal, safe integer checks and the existing CAD1,000,000,000-cent bound. One minute at CAD100/hour rounds to CAD1.67. No tax engine or assumed real zero tax is provided; only the explicitly labelled sample form starts with invented zero tax.

## Corrections, concurrency and privacy

Return an unissued month with a reason, then ask the member to save and resubmit its correction against the displayed current rate/mode. For an issued month, first use the existing **Void unpaid invoice** action, then return the month for correction. Reissue only after the member resubmits. The new document links its preserved original, while all prior submitted snapshots remain traceable. Paid or partially paid invoices and sending/unconfirmed delivery cannot use this correction path; financial adjustments remain outside this slice.

The database permits at most one non-void coaching invoice per member/month. Course invoices can coexist. All coaching writes reuse the existing lifetime-bounded invoice transaction, current verified-admin view, member/workspace fences and original-operation receipt table. Submitted data remains available to a current administrator after the member browser session expires; revocation and account deletion still deny access. Member reads/writes require the current member session.

Distinct administrators editing an ordinary member serialize on its workspace. Reciprocal or shared-self administrator/member targets can contend while upgrading the existing verified-authority locks. The existing bounded transaction fails unavailable and rolls back atomically; it does not retry. Inspect the original operation and current state before deliberate same-key recovery. If another valid write advanced the revision, an unchanged failed request conflicts and a newly reviewed form is required. A missing receipt alone does not prove a transaction did not commit.

Own structured export now appends coaching rates, monthly drafts/state, submitted history and own issued invoice documents. Existing cursor section positions are unchanged. Account erasure removes nonfinancial coaching records and sample invoices. Configured issued financial snapshots follow existing retention, unlinked from the deleted learning account and accessible only to an authorized administrator. This is not a legal retention-duration decision.

Invoicing stays disabled by default. Sample mode is limited to an isolated local preview, with invented issuer/tax and **SAMPLE · NOT PAYABLE** labels. Configured invoicing requires actual issuer/payment instructions and explicit CAD configuration; no provider or mode is activated by this issue. No automatic coaching invoice scheduling, email, card/bank charge, subscription, session timer or booking is added. Existing account/member lists and saved-month lists show at most100 records; retained direct references remain available.

## Behavioral contract and evidence mapping

Before implementation, the authenticated member HTTP test for `/account/coaching` observed404 instead of expected200 at base `4262dc8939a5ec5c569f6eac37b6c5bd897786d0`. The existing invoice entry, amount and configuration baseline passed25 tests. This is the recorded missing-behavior red, not a fabricated failing baseline for reused invoicing.

| AC / stable scenario | Executable evidence |
| --- | --- |
| AC1 / HOUR01 — register/recover and retain same private account | Native coaching entry; existing email baseline; L273 recovered account reference and own invoice journey |
| AC2 / HOUR02 — distinct effective rates, inheritance and missing rate | `coaching-store` unit rate/version cases; native two-member/inheritance tests; L273/L275 |
| AC3 / HOUR03 — save/confirm whole minutes and bounded rounded subtotal; zero remains distinct | `coaching-values` and routes unit tests; native zero/calendar/revision tests; L273/L275 |
| AC4 / HOUR04 — explicit reviewed issuance and private print | Native tax/immutable document test; invoice renderer unit test; L273 both rates/desktop/mobile print |
| AC5 / HOUR05 — stale versions, changed rates and preserved snapshots | Native rate/submit and issue/return races plus history; L274 stale-rate confirmation and correction |
| AC6 / HOUR06 — duplicates, distinct administrators and lost acknowledgements | Native distinct-admin and controlled shared-self contention; actual lost COMMIT acknowledgement for rate/save/submit/issue; L275 original receipt recovery |
| AC7 / HOUR07 — current verified admin, owner isolation and CSRF | Reused authority baseline; native denied member/staff/revoked admin and forged request tests; L274 direct-route denial |
| AC8 / HOUR08 — unpaid void/replacement and received-funds protection | Native replacement/active-index/course-coexistence/payment race tests; L274 preserved original and paid correction denial |
| AC9 / HOUR09 — honest modes, explicit tax and export/deletion | Native mode mismatch/expiry/101-rate two-page own export/sample erase/configured retention/controlled deletion race; L273/L275 sample and L276 disabled |

Tests live in `tests/unit/coaching-*.test.ts`, affected `simple-invoice-*`/export units, `tests/integration/coaching-invoices.test.ts`, existing invoice integration, and `tests/e2e/coaching-invoices.spec.ts`. New browser mappings L273–L276 append after L272; the slice grows from269 to273 registered scenarios (546 desktop/mobile executions); all existing IDs, required projects and full-MVP denominators remain. Focused results are development evidence; exact clean-commit full verification, independent final review, main source verification and the dedicated milestone demo are recorded on the issue/PR by the delivery owner.
