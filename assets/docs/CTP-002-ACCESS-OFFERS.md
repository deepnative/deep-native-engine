# CTP-002: learning access and optional coaching hypotheses

Updated 27 October 2026. Accountable owner: `tomqwu`. The owner delegated routine product/design decisions and selected an initial no-charge common foundation. This supersedes the 26 September private/local-only interim decision for access policy. Source: [current #95](https://github.com/deepnative/deep-native-engine/issues/95). Historical commercial terms below remain hypotheses.

## Current foundation access

Policy `2026-10-27-initial-foundation-v1` in [`src/offers.ts`](../../src/offers.ts) makes the common foundation available to all learner backgrounds for CAD 0 initially, without a coaching plan. Existing authenticated onboarding, learning and private saved progress supply that access; no new ledger grant, card, purchase or staff permission is created. Learning spaces retain their own capacity and explicit sharing rules. This is initial access, not a promise of a permanent price or service term.

The public access page, onboarding page and saved learning page describe the same policy. `/api/offer-hypotheses` returns the versioned `foundation` object separately from six nonpurchasable historical `coaching` rows. The old `preview`, `interimDecision`, `live` and `liveActivationEnabled` fields are replaced by explicit policy version, state, eligibility, price/currency, paid-plan requirement and scope. A policy label is not evidence that email delivery, hosted storage or every broader product feature is live-verified.

Foundation access grants zero live AI and paid-service units and no staff privileges. Existing separately seeded test units are not changed. Background `professional` does not select the historical Professional coaching offer. Optional coaching is unavailable; no acceptance, checkout, activation, reservation or service guarantee is introduced.

## Historical terms retained for planning

All amounts are **integer CAD cents** in code; the table displays CAD. Monthly figures are planned periods, never issued balances.

| Optional coaching hypothesis | Total CAD | Periods | Planned monthly allowances | Other boundaries |
| --- | ---: | ---: | --- | --- |
| Pilot | 3,000 | 2 | 60 coach, 60 review, 60 support minutes; 20 mock/100 study AI units; four pooled clinics | Each month has one 60-minute coaching unit (45 contact + 15 prep) and two 30-minute review units (20 review + 10 prep). Internal one-time onboarding reserve of 60 coach/30 support minutes is **not** a member credit. |
| Explicit timely continuation | 9,000 | 10, beginning in month 3 | 60 coach, 30 review, 30 support minutes; 20 mock/100 study; four pooled clinics | Ten CAD 900 installments or prepaid; needs explicit acceptance by the end of pilot period two. Ends on the original pilot anniversary. Late return needs a separately priced, explicitly accepted agreement with dates and credit treatment. |
| Direct Professional | 12,000 | 12 | 60 coach, 30 review, 30 support minutes; 20 mock/100 study; four pooled clinics | Twelve CAD 1,000 installments or prepaid. Background choice never selects this offer. |
| Specialist | 24,000 | 12 | 120 coach, 60 review, 60 implementation, 60 support minutes; 40 mock/200 study; four pooled clinics | Future optional hypothesis; twelve CAD 2,000 installments in source. |
| Practice | 48,000 | 12 | 180 coach, 120 review, 180 engineering, 120 support minutes; 60 mock/300 study; four pooled clinics | Future optional hypothesis; twelve CAD 4,000 installments in source. |
| Partner | 120,000 | 12 | 240 coach, 120 senior adviser, 240 review, 720 engineering, 480 analyst, 240 support minutes; four pooled clinics | Future optional hypothesis; twelve CAD 10,000 installments in source. AI maximum is negotiated and remains `null` in code. |

`billingMonth` computes each boundary from the **original** activation day in UTC, clipping only a short destination month. For example, 31 January 2026 → 28 February → 31 March; a timely continuation occupies months 3–12 and ends 31 January 2027. `plannedPeriods` returns one `planned-only` row per month. It does not create entitlements, reserve staff, invoke AI or bill. Clinic rows describe pooled group sessions, not four private bookings. The archived source's provider-specific cost, tax and cancellation details are not executable here.

## Separate optional-service dependencies

Actual paid offers require their own accepted terms, available human capacity, payment/issuer/tax facts and implemented reconciliation. Those remain in #27/#29/#32/#35 and #316–319 and do not block initial common-member access. No historical hypothesis becomes an offer merely because the foundation has no charge.

## Verification and limits

FAC-01 compares the versioned API and visible access policy; FAC-02 exercises ordinary general/professional/IT onboarding, saved progress/reload and staff denial; FAC-03 retains historical offer values and purchase/privilege separation. Unit/API tests cover the policy and page contract. Existing browser journey **L24** is amended under register `initial-learning-v108` without adding/removing IDs or reducing its critical flag; it uses real application/PostgreSQL behavior and both existing Chromium viewports.

The meaningful pre-change FAC-01/03 tests failed because the unchanged application returned the old pending-decision policy. Focused and full validation evidence is recorded on #95; this document does not claim an unexecuted gate or deployed result. Existing prescribed verification and merge/main-CI gates remain.

No database migration or external provider is added. Reverting this change restores earlier policy presentation without deleting accounts or private progress; no charge, paid grant or service reservation must be reversed.
