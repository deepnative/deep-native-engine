# QA-002: browser journey traceability and release gate

Prepared 2026-09-23 for [QA-002 #17](https://github.com/deepnative/deep-native-engine/issues/17). This is a **proposed** `full-mvp-v1` release register for review. It does not certify that the full MVP exists or that a release test has passed.

## Two denominators

[`tests/e2e/scenarios.json`](../../tests/e2e/scenarios.json) contains the executable local learning slice under its own `version` and the preserved full-MVP inventory under `fullMvpVersion`. The latter has **27 source requirement families and 100 separately countable browser scenario IDs**:

| Source family | Requirement families | Reserved full-release browser IDs | Current passing full-release IDs |
| --- | ---: | ---: | ---: |
| Original roadmap | ROADMAP-01 through ROADMAP-09: 9 | `F-ROADMAP-01-A` through `F-ROADMAP-09-D`: 36 | 0 |
| Final build prompt | BUILD-01 through BUILD-10: 10 | `F-BUILD-01-A` through `F-BUILD-10-D`: 40 | 0 |
| Expanded ecosystem direction | ECO-01 through ECO-08: 8 | `F-ECO-01-A` through `F-ECO-08-C`: 24 | 0 |
| **Full release** | **27** | **100** | **0** |

Every family retains its source requirement text, actor, preconditions, end-to-end steps, expected result, issue links, risk, criticality and `outstanding` state. Each child case has a reserved browser ID plus its own action and observable result. Browser tests must use exactly `[F-…]` in their title. These are proposed acceptance scenarios; reserved IDs are not tests and do not count as passing. The local slice's passing IDs remain separate. The gate's full-MVP report names every uncovered ID, the 100-case denominator and the critical-case count.

The issue links in each family identify the implementation acceptance areas it exercises. Specific case actions and results are the concrete checks to use when those issues are delivered. Issue text and the immutable source archive remain authoritative for obligations that are not yet implemented; mapping overlap never deletes a case. The following relationships explain intentional cross-source overlap:

| Original concern | Expanded/recovery concern | Separate evidence required |
| --- | --- | --- |
| ROADMAP-01 member to reviewer | BUILD-02 private assessment, ECO-01 general learner | Human assessment, cross-member denial and noncoding foundation entry each have distinct tests. |
| ROADMAP-03 last slot/unit | BUILD-03 concurrency | Race, cancellation and replacement-credit history remain independent assertions. |
| ROADMAP-04 pilot phases | BUILD-04 late return, BUILD-05 event disorder, ECO-07 optional offer | Original anniversary, late agreement, payment ordering and background/paid-tier separation all remain required. |
| ROADMAP-05 AI consent/cost | BUILD-06 failure and injection, ECO-06 general study | Consent, budget, grounding, prompt isolation and noncareer study have distinct cases. |
| ROADMAP-06 content versions | BUILD-07 retired template, ECO-05 contribution | Rubric pinning, template support and reviewed member publication are different lifecycles. |
| ROADMAP-09 reconciliation/deletion | BUILD-08 privacy, BUILD-09 commercial truth, ECO-08 separate metrics | Billing exceptions, data deletion and honest metrics require separate evidence. |

## Proposed mapping audit, 24 September 2026

I compared all 27 family requirement strings with their [roadmap source](context/source-2026-09-15/outputs/contractor-platform/03-roadmap-and-backlog.md), [build-prompt source](context/source-2026-09-15/outputs/contractor-platform/02-codex-build-prompt.md), and [ecosystem source](context/ECOSYSTEM-JOURNEYS.md). All 27 retain the source wording. I then checked each of the 100 child IDs and its action/result against its family, including the separate IT, non-IT professional, and general learner paths. The following is the review record; A–D or A–C refer to the `F-<family>-<letter>` IDs in the register.

| Family | Proposed case split checked against source |
| --- | --- |
| ROADMAP-01 | A pilot allowance; B foundation/assignment; C private review; D revision/export. |
| ROADMAP-02 | A cross-member denial; B assigned review; C revoked download; D editor isolation. |
| ROADMAP-03 | A last slot; B last unit; C cancellation/no-show; D provider failure and staff time. |
| ROADMAP-04 | A pilot; B explicit continuation; C direct annual/renewal; D payment and refund exception. Nonconversion is separately explicit in BUILD-04-B. |
| ROADMAP-05 | A opt-out/provider mode; B limits; C timeout/retry; D sparse evidence/source/budget. |
| ROADMAP-06 | A pinned rubric; B new version; C retired template; D document instruction isolation. |
| ROADMAP-07 | A continued monthly allowance; B clinic; C funded support; D goal/renewal/contract claims. |
| ROADMAP-08 | A cyber/product/project foundation; B uncovered specialty; C sale readiness; D project assignment. |
| ROADMAP-09 | A booking exception; B early release/refund; C reconciliation; D export/deletion. |
| BUILD-01 | A cyber branch; B noncoding business analysis; C unavailable tailored review; D demo expert. |
| BUILD-02 | A evidence revisions; B pinned authorized feedback; C outsider denial; D revoked reviewer link. |
| BUILD-03 | A last slot race; B last credit race; C replacement credit; D attempt history. |
| BUILD-04 | A pilot continuation; B no conversion/no further charge; C late agreement; D direct annual/renewal. |
| BUILD-05 | A duplicate event; B out-of-order event; C refund/early release; D missing-event reconciliation. |
| BUILD-06 | A grounded feedback; B sparse evidence; C injection isolation; D timeout/malformed output. |
| BUILD-07 | A rubric pinning; B retired template; C workflow bytes/version; D sample tests. |
| BUILD-08 | A owner export; B sharing revocation; C source/derived deletion; D retention exceptions. |
| BUILD-09 | A demo/seed metrics; B unpublished offer; C uncovered capacity; D agreement snapshot. |
| BUILD-10 | A mobile/keyboard; B validation/empty state; C loading/error recovery; D persisted flow. |
| ECO-01 | A exploratory registration; B noncoding foundation; C private progress. This is the general learner path. |
| ECO-02 | A IT assignment; B non-IT professional assignment; C access/readiness comparison. |
| ECO-03 | A goal change/evidence; B return/resume; C empty/error recovery. |
| ECO-04 | A bounded circle/private work; B reporting/moderation; C leave/revocation. |
| ECO-05 | A attributed proposal; B authorized approval/rejection; C sharing revocation. |
| ECO-06 | A general/professional study choice; B grounded opted-in help; C disabled provider/budget. |
| ECO-07 | A optional offer/capacity; B explicit versioned acceptance; C cancellation/export/background change. |
| ECO-08 | A separate outcome measures; B demo/self-report labels; C unauthorized drill-down. |

The source-to-case comparison found no missing family, duplicate case ID, or justified change to the proposed denominator. The six noncritical IDs are ECO-02-A–C and ECO-03-A–C; all other 94 remain critical. ECO-04's source names QA-004 as well as CTP-005/020/021, so its register issue links now include #18. Overlap between ROADMAP and BUILD cases remains separately countable as described above. The gate protects this **proposal** from silent ID removal, substitution, or criticality downgrade; a deliberate scope change needs a new version and reviewed gate update. Independent approval of the mapping is still pending, and full-MVP browser coverage remains **0/100**. This audit neither runs those journeys nor certifies release readiness.

## Execution and failure rules

The existing `make verify` checks the **approved local-slice** browser matrix and reports full-MVP coverage as **0/100 outstanding**. It does not silently promote a local test to full-release evidence. `scripts/quality-gates.mjs` validates each family/case definition, unique reserved IDs and the exact passing browser/project matrix. A full-release report must contain the real browser scenarios on every registered browser and pass `assertFullReleaseJourneys`. The future release gate can be invoked with:

```sh
npm run verify:full-e2e -- artifacts/e2e-full-results.json
```

The command fails closed when the full report is missing, empty, unmapped, incomplete, skipped, failed, retried, duplicated or below coverage. It writes `artifacts/full-release-verification.json`. The release target is at least 99% of approved scenario IDs, 100% of critical IDs and 100% pass of executed required tests; the current matrix also requires every registered browser execution, so all 100 IDs must be present. A manually changed `status` cannot substitute for browser evidence.

Unit probes deliberately corrupt source coverage and browser reports, including missing mapping, skipped/failed/retried tests, wrong browser, duplicate IDs, missing definition, false completion and an incomplete full-release matrix. Full-release feature browser tests are not yet present; running the release command against the current local-slice report must fail. The 100-case proposal requires independent scenario review before it becomes an approved release denominator. Later scope changes must update the version, preserve provenance and record why any case is split or superseded. No passing local gate, documentation review or overlap table completes the member-to-reviewer, payment, participation or other full-MVP cases.
