# CTP-002: learning access and optional coaching hypotheses

Date: 2026-09-23. Scope: local synthetic preview and read-only offer planning. Accountable GitHub owner: `netcsc`. Review and owner approval are pending. Source: [current product direction](PRODUCT-DIRECTION.md), [CTP-001 architecture audit](CTP-001-ARCHITECTURE-AUDIT.md), live [CTP-002 #19](https://github.com/deepnative/deep-native-engine/issues/19), and the immutable 15 September 2026 source package.

## Boundary

The common learning and participation foundation is a product path for IT, other professionals and general learners. A learner's background is descriptive; `professional` is neither a paid plan nor a staff permission. The only implemented access in this slice is the existing loopback preview using sample information. Live foundation admission, services, AI, participation limits and price are **pending owner decision**. No free tier or unbudgeted entitlement is implied.

The six coaching rows in [`src/offers.ts`](../../src/offers.ts) are immutable **hypothesis version `2026-09-15-hypothesis-v1`**. All are `livePurchasable: false`. The read-only [`/readiness/offers`](../../src/app.ts) page and `/api/offer-hypotheses` expose the same catalog for planning and QA. They do not implement an acceptance, checkout, credit ledger or live grant. There is no live offer activation path in this slice. Before a future version can be sold, owners must approve the exact terms and version, foundation access rules, capacity, tax/payment behavior and buyer-facing disclosures, then implement and test a separate purchase/grant workflow. A UI label or annual prepayment must never itself issue credits.

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

## Owner decisions and release blockers

| Decision needed | Current state | Consequence |
| --- | --- | --- |
| Who may receive hosted foundation and participation access, with what price/subsidy, usage limits, AI allowance and moderation/support budget? | Pending | No live foundation grant; local sample preview only. |
| Which coaching versions, if any, may be offered; exact service definitions, availability, cancellation/refund terms, payment schedule, taxes and disclosures? | Pending | Every row remains a nonpurchasable hypothesis. |
| Is there qualified coach/reviewer/support coverage for each promised unit and relevant audience/specialty? | Unconfirmed; see [PLAN-003 capacity operations](PLAN-003-CAPACITY-OPERATIONS.md) | No paid promise or service booking. |
| How will accepted terms, payment events, monthly credit issuance, failed installments, refunds and late return be persisted and audited? | Future implementation; see CTP-011/CTP-017 and ROADMAP-04 | No sale, charge or credit ledger in this slice. |
| Who approves the foundation model and each live offer version and reviews privacy, operations and rollback? | Named owner/reviewer and dated approval pending | This document and code are planning evidence, not release authorization. |

## Verification and limits

[`tests/unit/offers.test.ts`](../../tests/unit/offers.test.ts) checks table amounts, quotas, versions, month boundaries, validation and continuation timing. [`tests/unit/app.test.ts`](../../tests/unit/app.test.ts) and browser journey **L24** compare the page with the server catalog and assert the live purchase boundary. The shared `make verify` gate records exact commit/tree, raw 99% unit metrics, repository tests, PostgreSQL integration, both Chromium viewports and the full approved slice register. The register retains all 27 outstanding full-MVP requirements. Passing this local gate proves only the synthetic planning slice; it cannot establish approved commercial terms, real capacity, billing correctness, hosted access or launch readiness.

Rollback for this slice is removal of the read-only routes and catalog; no migrations, external payment events or live grants are introduced. The catalog contains no member information. The `/readiness/offers` page states that the figures are historical hypotheses and offers no purchase action.
