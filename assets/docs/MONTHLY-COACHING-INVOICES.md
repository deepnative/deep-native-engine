# Coaching hours and individual invoices

> Since [#832](https://github.com/deepnative/deep-native-engine/issues/832) (owner decisions of 12 November 2026) an administrator can set a billing period per student and change reported hours. A student with no billing period set reports by calendar month exactly as described below; see [Billing periods](#billing-periods) and [Administrator changes to reported hours](#administrator-changes-to-reported-hours). The pages are now named **Coaching hours** (student) and **Coaching administration**; the table of saved hours is **Saved periods** and the review list is **Pending periods**.

Issue [#576](https://github.com/deepnative/deep-native-engine/issues/576) adds one optional journey: register or recover the same learning account, let a current verified administrator set its agreed hourly rate, save and submit a calendar month's coaching duration, then let the administrator review and issue one private invoice. Registration, rate assignment and submission take no payment and grant no paid entitlement. The existing [course invoice system](SIMPLE-COURSE-INVOICES.md) owns the documents, payment records, printing, unpaid voids and operation recovery.

## Member and administrator actions

Open **Coaching hours** in the header (or **My account → Coaching hours**) and select the past UTC calendar month to invoice. Save whole hours and additional minutes, plus the individual invoice name/email. Reload to inspect the saved draft. The page shows the applicable rate and version and the subtotal before separately supplied tax. Confirm the exact saved draft and choose **Request coaching invoice**. The administrator reviews the request before issuing it; this is monthly hours reporting, with no prepaid balance or automatic charge. The billing email does not change login identity; existing verified-email attachment/recovery restores the same account and its records.

From **Administration → Coaching administration**, select the member reference. Set a positive CAD hourly rate and an effective month; later months inherit it until another effective rate applies. Future effective rates are allowed, future reported hours are not. Review the pending month and choose **Issue coaching invoice**. Real (configured) invoices add 13% HST to the subtotal automatically ([#32](https://github.com/deepnative/deep-native-engine/issues/32)); only sample invoices ask for an invented tax. The same invoice appears under the member's **Courses and invoices**, with browser Print/Save as PDF. Two invented examples are 90 minutes at CAD120/hour = CAD180 and 90 minutes at CAD80/hour = CAD120, before tax. These examples are not real prices.

Drafts have optimistic revisions. Submission freezes its duration, exact rate/version, recipient, rounded subtotal and sample/configured mode. A changed rate or stale form requires reopening and explicit confirmation. A later rate change never rewrites a submitted or issued snapshot. A sample submission cannot become payable after a configured-mode restart: issuance refuses the mismatch until the month is returned and the member explicitly resubmits in the new mode.

Zero hours remains distinguishable from no submission. Zero hours and a positive duration that rounds to zero are retained as submitted records with no invoice, even if tax is supplied. Minutes must fit the selected calendar month, including leap February. Amounts use whole cents, `floor((minutes × hourlyRateCents + 30) / 60)` once at the subtotal, safe integer checks and the existing CAD1,000,000,000-cent bound. One minute at CAD100/hour rounds to CAD1.67. Configured invoices compute 13% HST from the subtotal, rounded half up to the cent; only the explicitly labelled sample form starts with invented zero tax.

## Manager hours dashboard

**Administration → Coaching administration** opens on a read-only dashboard for one calendar month (default: the previous UTC month; future months are refused). Summary figures: hours submitted (submitted and invoiced months only, drafts excluded) and the number of contractors; months awaiting review across all months with the oldest wait in days; amount invoiced and invoices not yet sent for the month; outstanding balance on the month’s invoices. Voided invoices are left out.

The contractor table lists up to 100 members who have a rate in effect for the month or hours that year: name and short reference, applicable rate, hours for the month, the previous month and year to date, status (awaiting review, returned for correction, draft, invoice voided, invoiced, not started), invoice email and balance. Sort by name, hours, year to date or status; each name opens that member’s month. Only a current verified administrator can open it; it shows no private learning content. Scenarios DASH-01..04 (#614): PostgreSQL aggregates, route rendering/sorting/refusals, and L284 browser checks before review and after payment.

## Corrections, concurrency and privacy

Return an unissued month with a reason, then ask the member to save and resubmit its correction against the displayed current rate/mode. For an issued month, first use the existing **Void unpaid invoice** action, then return the month for correction. Reissue only after the member resubmits. The new document links its preserved original, while all prior submitted snapshots remain traceable. Paid or partially paid invoices and sending/unconfirmed delivery cannot use this correction path; financial adjustments remain outside this slice.

The database permits at most one non-void coaching invoice per member/month. Course invoices can coexist. All coaching writes reuse the existing lifetime-bounded invoice transaction, current verified-admin view, member/workspace fences and original-operation receipt table. Submitted data remains available to a current administrator after the member browser session expires; revocation and account deletion still deny access. Member reads/writes require the current member session.

Distinct administrators editing an ordinary member serialize on its workspace. Reciprocal or shared-self administrator/member targets can contend while upgrading the existing verified-authority locks. The existing bounded transaction fails unavailable and rolls back atomically; it does not retry. Inspect the original operation and current state before deliberate same-key recovery. If another valid write advanced the revision, an unchanged failed request conflicts and a newly reviewed form is required. A missing receipt alone does not prove a transaction did not commit.

Own structured export now appends coaching rates, monthly drafts/state, submitted history and own issued invoice documents. Existing cursor section positions are unchanged. Account erasure removes nonfinancial coaching records and sample invoices. Configured issued financial snapshots follow existing retention, unlinked from the deleted learning account and accessible only to an authorized administrator. This is not a legal retention-duration decision.

Invoicing stays disabled by default. Sample mode is limited to an isolated local preview or a host that shows the demo-site banner (`DNE_DEMO_SITE=enabled`), with invented issuer/tax and **SAMPLE · NOT PAYABLE** labels. Configured invoicing requires actual issuer/payment instructions and explicit CAD configuration; this issue activated no mode. The hosted engine ran configured CAD invoicing from [#624](https://github.com/deepnative/deep-native-engine/issues/624) until 4 November 2026, when it became a demo site with sample invoices. In both modes Coaching hours and the hours dashboard are available there to current administrators. No automatic coaching invoice scheduling, email, card/bank charge, subscription, session timer or booking is added. Existing account/member lists and saved-month lists show at most100 records; retained direct references remain available.

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

L284 (#611) runs the whole journey through visible navigation: browser registration and email sign-in, owner entry from Administration, rate, Coaching hours for a chosen past month, review/issue from Pending months, simulated invoice email, full offline payment and the student’s Paid view, with sideways-scroll and control-size checks on every page. It found and fixed unstyled email/number/month/untyped fields, an invoice-email action offered when no sender is configured, a member named only by account reference on the review page, and a header that always highlighted Account.

Tests live in `tests/unit/coaching-*.test.ts`, affected `simple-invoice-*`/export units, `tests/integration/coaching-invoices.test.ts`, existing invoice integration, and `tests/e2e/coaching-invoices.spec.ts`. New browser mappings L273–L276 append after L272; the slice grows from269 to273 registered scenarios (546 desktop/mobile executions); all existing IDs, required projects and full-MVP denominators remain. Focused results are development evidence; exact clean-commit full verification, independent final review, main source verification and the dedicated milestone demo are recorded on the issue/PR by the delivery owner.

## Saved periods table

Coaching hours lists saved months and periods as a table ([#646](https://github.com/deepnative/deep-native-engine/issues/646)), newest first:

- **Period:** the calendar month, or a billing period's first and last day; opens it.
- **Hours:** the saved hours.
- **Amount:** the issued invoice total, the submitted snapshot subtotal, or, for a draft, the hours at the applicable rate. "No rate" shows when none applies.
- **Status:** Draft, Returned for correction, Awaiting review, Invoiced · Paid, Invoiced · CAD x due, or Void.
- **Invoice:** a link to the issued invoice.

The administrator's member view shows the same table, with links to the admin invoice pages. HOURTABLE-01–03 are unit tests; L273 and L284 check the table in the browser.

## Administrator changes to reported hours

Owner decision of 12 November 2026 ([#832](https://github.com/deepnative/deep-native-engine/issues/832)): an administrator can change hours a student has reported, and cannot enter hours for a student.

- **Where:** Administration → Coaching administration → the student → the month or period. Under **Change this student's hours**, enter the hours and minutes and a **Reason for the change**, then choose **Change hours**.
- **When it is offered:** only while the month is a draft or awaiting review. If the student has not saved hours for the month, the page says so and offers no form; a posted change is refused, and the database refuses a change record for a month with no saved hours. An invoiced month offers no form: void the unpaid invoice and return the month first, as before.
- **What changes:** a draft takes the new hours and stays the student's to submit. A month awaiting review stays awaiting review, at the rate version the student confirmed, with the subtotal recalculated; the student's own submission stays in the retained history. The invoice is then issued on the changed figure.
- **What is kept:** each change records the earlier figure, the new figure, the reason, the administrator and the time. It can't be edited or removed, except with the student's account.
- **What the student sees:** **Hours changed by an administrator** on Coaching hours, with the date, both figures and the reason, never the administrator's name. Saved periods marks it "changed by an administrator". Download my records lists each change (`coachingHoursOverrides`, export v51 onwards).
- **Who and when:** Change history (`/operator/changes`) says which administrator changed which student's hours for which month, without the reason.
- **Stale forms:** a change advances the month's revision, so a save, change or issue form opened before it is refused and must be reopened.

Scenarios OVR832-01..08: `tests/unit/coaching-store.test.ts`, `tests/unit/coaching-routes.test.ts`, `tests/unit/member-export.test.ts`, `tests/integration/coaching-hours-overrides.test.ts` and browser journey L338 (`tests/e2e/coaching-hours-override.spec.ts`, desktop and Pixel 7). Migration 140.

## Billing periods

Owner decisions of 12 November 2026 ([#832](https://github.com/deepnative/deep-native-engine/issues/832)): an administrator defines the billing period for each student; the default is 2 weeks.

**Setting it.** Administration → Coaching administration → the student → **Billing period**. Choose **Billing period length**: 2 weeks (preselected), 1 week, 1 month, or **Custom number of days** with 1 to 31 in the next field. The first time, also give **First period starts on (UTC date)**, then choose **Save billing period**.

- Periods run back to back from the start date. One month runs to the day before the same day of the next month; a start on the 29th to 31st uses the last day of shorter months.
- The start date must be within a year of today and after the last month or period the student has already saved hours for, so nothing overlaps. It can be in the past.
- Once a period has started, the form no longer asks for a date. A new length applies from the day after the current period ends, and the page says which day that is. A change that has not started yet is replaced by a newer one. Saved, submitted and invoiced periods are never rewritten.
- Each setting is kept as a version with the administrator and time. Change history says who set it and from which day.

**For the student.** Coaching hours shows **Your billing period** and, once a period has started, a **Billing period** picker (the current period and up to 59 earlier ones) in place of the month field. The student saves hours and requests the invoice for each period, up to 24 hours for each of its days. A period that has not started cannot be opened.

**Invoicing.** One non-void coaching invoice per student per period. A defined period can be invoiced only from the day after its last day (UTC); before that the administrator's page says from when, and offers changing the hours or returning them. The store, the route and a database trigger all refuse an earlier invoice. The invoice line reads "Coaching · 2026-11-16 to 2026-11-29" and the invoice shows the billing period.

**Rate.** The rate in effect on the period's first day applies: the newest rate whose effective month is at or before the month of that day. Rates are still set by effective month.

**Existing calendar months.** Every month saved before a billing period is set stays as it is: readable, correctable and invoiced as a calendar month. A student with no billing period set keeps reporting by calendar month and can be invoiced during the month, as before. A calendar month that ends before the first period can still be reported; one the periods reach into cannot.

**Dashboard, console and coach page.** The manager dashboard stays a calendar-month report. A billing period counts in the month it ends, which is when it can be invoiced. A student with several periods ending in the month shows their total submitted hours and the status of the period that most needs attention, and their name opens that period. The administration console's month columns and the coach's page list a period in the month it ends, by its dates.

**Records.** `coaching_months` keeps the key `(owner_id, month)`; `month` holds the period key, `YYYY-MM` for a calendar month or the period's first day, with `period_start` and `period_end` beside it. The database refuses overlapping periods for one student and changes to a saved period's dates. Settings are in `coaching_billing_schedules` (migration 141). Download my records carries `periodStart` and `periodEnd` on `coachingMonths` and lists the settings in `coachingBillingSchedules` (export v52), without the administrator. Deleting the account removes both.

Scenarios PERIOD832-01..10: `tests/unit/coaching-values.test.ts`, `coaching-store.test.ts`, `coaching-routes.test.ts`, `member-export.test.ts`, `simple-invoice-views.test.ts`, `coach-view.test.ts`, `account-role-admin.test.ts`; `tests/integration/coaching-billing-periods.test.ts` and `administrator-entry.test.ts`; browser journey L339 (`tests/e2e/coaching-billing-periods.spec.ts`, desktop and Pixel 7).
