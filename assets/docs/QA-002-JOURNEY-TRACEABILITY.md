# QA-002: browser journey traceability and release gate

Prepared 2026-09-23 for [QA-002 #17](https://github.com/deepnative/deep-native-engine/issues/17), with independent technical mapping approval recorded on [#94](https://github.com/deepnative/deep-native-engine/issues/94#issuecomment-5820945526) on 24 September. The `full-mvp-v1` source-to-case mapping is approved; the complete full-MVP browser suite remains **unimplemented and unexecuted**. This does not certify that the full MVP exists or that a release test has passed.

## Two denominators

[`tests/e2e/scenarios.json`](../../tests/e2e/scenarios.json) contains the executable local learning slice under its own `version` and the preserved full-MVP inventory under `fullMvpVersion`. The latter has **27 source requirement families and 100 separately countable browser scenario IDs**:

| Source family | Requirement families | Reserved full-release browser IDs | Current passing full-release IDs |
| --- | ---: | ---: | ---: |
| Original roadmap | ROADMAP-01 through ROADMAP-09: 9 | `F-ROADMAP-01-A` through `F-ROADMAP-09-D`: 36 | 0 |
| Final build prompt | BUILD-01 through BUILD-10: 10 | `F-BUILD-01-A` through `F-BUILD-10-D`: 40 | 0 |
| Expanded ecosystem direction | ECO-01 through ECO-08: 8 | `F-ECO-01-A` through `F-ECO-08-C`: 24 | 0 |
| **Full release** | **27** | **100** | **0** |

Every family retains its source requirement text, actor, preconditions, end-to-end steps, expected result, issue links, risk, criticality and `outstanding` state. Each child case has a reserved browser ID plus its own action and observable result. Browser tests must use exactly `[F-…]` in their title. These are proposed acceptance scenarios; reserved IDs are not tests and do not count as passing. The local slice's passing IDs remain separate. The gate's full-MVP report names every uncovered ID, the 100-case denominator and the critical-case count.

Each of the 100 cases now also names its mandatory `requiredChecks`: a concrete action and observable expected result for each required subcase. After the #158 ECO-04 moderation finding and #161 correction, the proposal has **206 required checks**, with 77 cases needing more than one and 23 requiring one. These checks are obligations *inside* the existing case IDs; they do not add passing IDs or change the 100-case/94-critical denominator. The check array is part of the mapping approval digest, so a later edit invalidates approval until reviewed again.

The issue links in each family identify the implementation acceptance areas it exercises. Specific case actions and results are the concrete checks to use when those issues are delivered. Issue text and the immutable source archive remain authoritative for obligations that are not yet implemented; mapping overlap never deletes a case. The following relationships explain intentional cross-source overlap:

| Original concern | Expanded/recovery concern | Separate evidence required |
| --- | --- | --- |
| ROADMAP-01 member to reviewer | BUILD-02 private assessment, ECO-01 general learner | Human assessment, cross-member denial and noncoding foundation entry each have distinct tests. |
| ROADMAP-03 last slot/unit | BUILD-03 concurrency | Race, cancellation and replacement-credit history remain independent assertions. |
| ROADMAP-04 pilot phases | BUILD-04 late return, BUILD-05 event disorder, ECO-07 optional offer | Original anniversary, late agreement, payment ordering and background/paid-tier separation all remain required. |
| ROADMAP-05 AI consent/cost | BUILD-06 failure and injection, ECO-06 general study | Consent, budget, grounding, prompt isolation and noncareer study have distinct cases. |
| ROADMAP-06 content versions | BUILD-07 retired template, ECO-05 contribution | Rubric pinning, template support and reviewed member publication are different lifecycles. |
| ROADMAP-09 reconciliation/deletion | BUILD-08 privacy, BUILD-09 commercial truth, ECO-08 separate metrics | Billing exceptions, data deletion and honest metrics require separate evidence. |

## Mapping audit and independent technical decision, 24 September 2026

I compared all 27 family requirement strings with their [roadmap source](context/source-2026-09-15/outputs/contractor-platform/03-roadmap-and-backlog.md), [build-prompt source](context/source-2026-09-15/outputs/contractor-platform/02-codex-build-prompt.md), and [ecosystem source](context/ECOSYSTEM-JOURNEYS.md). All 27 retain the source wording. I then checked each of the 100 child IDs and its action/result against its family, including the separate IT, non-IT professional, and general learner paths. The following is the review record; A–D or A–C refer to the `F-<family>-<letter>` IDs in the register.

| Family | Proposed case split checked against source |
| --- | --- |
| ROADMAP-01 | A pilot allowance; B foundation/assignment and publication without competence; C private assigned review; D revision/export. |
| ROADMAP-02 | A cross-member denial; B assigned review; C revoked download; D editor isolation. |
| ROADMAP-03 | A last slot; B last unit; C cancellation/no-show; D provider failure and staff time. |
| ROADMAP-04 | A pilot; B explicit continuation; C direct annual/renewal; D payment and refund exception. Nonconversion is separately explicit in BUILD-04-B. |
| ROADMAP-05 | A opt-out/provider mode; B limits; C timeout/retry; D sparse evidence/source/budget. |
| ROADMAP-06 | A pinned rubric; B new version; C retired template; D document instruction isolation. |
| ROADMAP-07 | A continued monthly allowance; B clinic; C funded support; D goal/renewal/contract claims. |
| ROADMAP-08 | A cyber/product/project foundation; B uncovered specialty; C sale readiness; D project assignment. |
| ROADMAP-09 | A booking exception; B early release/refund; C reconciliation; D owner and authorized-operator export with denial paths, deletion and retention. |
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
| ECO-04 | A bounded circle/private work; B reporting, scoped accountable moderator action and outsider/peer/revoked-moderator denials; C leave/revocation. |
| ECO-05 | A attributed proposal; B authorized approval/rejection; C sharing revocation. |
| ECO-06 | A general/professional study choice; B grounded opted-in help; C disabled provider/budget. |
| ECO-07 | A optional offer/capacity; B explicit versioned acceptance; C cancellation/export/background change. |
| ECO-08 | A separate outcome measures; B demo/self-report labels; C unauthorized drill-down. |

The table covers all 27 families and all 100 IDs. For completeness, this is the check-count audit by case letter; the register itself records the action and observable assertion for each of the 206 checks.

| Family | Required checks by case ID suffix |
| --- | --- |
| ROADMAP-01 | A:2, B:3, C:3, D:2 |
| ROADMAP-02 | A:3, B:1, C:3, D:1 |
| ROADMAP-03 | A:2, B:2, C:2, D:2 |
| ROADMAP-04 | A:2, B:2, C:2, D:7 |
| ROADMAP-05 | A:3, B:3, C:2, D:3 |
| ROADMAP-06 | A:2, B:2, C:2, D:2 |
| ROADMAP-07 | A:2, B:1, C:2, D:3 |
| ROADMAP-08 | A:3, B:2, C:2, D:1 |
| ROADMAP-09 | A:1, B:2, C:3, D:8 |
| BUILD-01 | A:1, B:1, C:1, D:1 |
| BUILD-02 | A:2, B:1, C:2, D:3 |
| BUILD-03 | A:1, B:1, C:1, D:2 |
| BUILD-04 | A:2, B:2, C:2, D:2 |
| BUILD-05 | A:1, B:1, C:2, D:1 |
| BUILD-06 | A:1, B:1, C:2, D:2 |
| BUILD-07 | A:2, B:2, C:2, D:1 |
| BUILD-08 | A:2, B:1, C:2, D:2 |
| BUILD-09 | A:2, B:1, C:2, D:2 |
| BUILD-10 | A:2, B:2, C:2, D:2 |
| ECO-01 | A:2, B:1, C:2 |
| ECO-02 | A:2, B:2, C:2 |
| ECO-03 | A:2, B:2, C:2 |
| ECO-04 | A:2, B:6, C:2 |
| ECO-05 | A:2, B:3, C:2 |
| ECO-06 | A:2, B:2, C:2 |
| ECO-07 | A:2, B:2, C:3 |
| ECO-08 | A:3, B:2, C:1 |

The formerly ambiguous alternatives are now explicit conjunctions. `F-ROADMAP-01-B` requires published eligible content to leave assessed competence and completed human review unset when there is no assessment; `F-ROADMAP-01-C` separately requires legitimate assigned-review behavior. `F-ROADMAP-09-D` requires owner export, member-authorized operator export, absent/expired/out-of-scope operator denials, and deletion/retention. `F-ECO-04-B` now requires an authorized moderator's reported-scope action with actor/reason audit and no unrelated private-work access, plus separate outsider, peer and revoked-moderator denials without a moderation effect or private disclosure. `F-ROADMAP-03-C` requires a tested cancellation policy **and** a tested no-show policy; `F-ROADMAP-03-D` separately tests provider failure. `F-ECO-06-C` requires both an unavailable-provider response and a budget-stop response. `F-ECO-07-C` requires cancellation rights, authorized export, **and** background-change isolation. A policy-dependent result such as restored *or* forfeited credit remains conditional on the declared policy, but both triggering paths and the corresponding dated outcome must be asserted. Other compound IDs explicitly separate payment event order, refund decisions, timeout and malformed output, owner and outsider reads, retired and unverified templates, consent and rejection, mobile and keyboard access, and empty and error recovery.

The source-to-case comparison found no missing family, duplicate case ID, or justified change to the proposed denominator. The six noncritical IDs are ECO-02-A–C and ECO-03-A–C; all other 94 remain critical. ECO-04's source names QA-004 as well as CTP-005/020/021, so its register issue links now include #18. Overlap between ROADMAP and BUILD cases remains separately countable as described above. The gate protects the **approved mapping** from silent ID removal, substitution, or criticality downgrade; a deliberate scope change needs a new version and reviewed gate update. The independent technical review approved this mapping, while full-MVP browser coverage remains **0/100**. This audit neither runs those journeys nor certifies release readiness.

The source strings, family IDs, case IDs, source links, issue links and critical flags are unchanged by the ECO-04 subcase correction. The approved `full-mvp-v1` mapping digest is `581083999c08f794b3814470a2e2a708f3708ff0ea6dd9785999ce5a1bdf3a45`. The preceding digests `0345855e5b331e2be1a4403a27f6af0128e0a1c3b83f9d50abaaef7bc623be81` and `14963de159ede2a79d43b963d0d7c974fc124538c7738ea1c36933fb90850631` no longer identify this mapping. After #158 requested changes, a [separate GPT-6 Astra/high reviewer in #163](https://github.com/deepnative/deep-native-engine/issues/163) compared all 206 checks to the three sources and browser evidence rule, then [approved the technical mapping on #94](https://github.com/deepnative/deep-native-engine/issues/94#issuecomment-5820945526). This records source-to-check approval only. Every full-MVP browser case still needs real, first-attempt execution and substantive assertion review.

## Execution and failure rules

The existing `make verify` checks the **approved local-slice** browser matrix and reports full-MVP coverage as **0/100 outstanding**. It does not silently promote a local test to full-release evidence. `scripts/quality-gates.mjs` validates each family/case definition, unique reserved IDs and the exact passing browser/project matrix. A full-release report must contain the real browser scenarios on every registered browser and pass `assertFullReleaseJourneys`. The full-release runner is:

```sh
npm run verify:full-e2e
```

The command accepts no caller-supplied browser report. It clears prior full-release artifacts, requires a clean Git revision and the tracked `tests/e2e/full-mvp-approval.json` decision, creates an isolated loopback PostgreSQL database and private storage, builds the app, and runs the complete `playwright.full.config.ts` suite itself. The Playwright metadata carries a freshly generated run ID and the tested commit/tree. The runner checks that the revision stayed clean and unchanged, the report came from this run on the registered browser matrix with no retries, and every browser execution has a retained trace archive. The report and trace hashes, run identity, exact revision, runtime and PostgreSQL version are recorded in `artifacts/full-release-verification.json`; database and storage cleanup are required for a pass. Missing approval, a changed mapping, stale or dirty source, absent/mismatched evidence, failed tests or cleanup fail the command.

The [tracked approval file](../../tests/e2e/full-mvp-approval.json) records the [#163 independent technical decision](https://github.com/deepnative/deep-native-engine/issues/94#issuecomment-5820945526): the separate reviewer identity, decision URL and timestamp, and SHA-256 digest of `{ version: fullMvpVersion, projects, fullMvp }` using JSON serialization in `releaseMappingDigest`. The reviewer and decision comment are the authority; the digest binds the reviewed content and browser matrix. A later mapping or browser-matrix change invalidates this approval. A browser result cannot approve its own register. This is technical mapping approval only, not qualified content review, Phase B acceptance, or launch approval.

The command fails closed when the full report is missing, empty, unmapped, incomplete, skipped, failed, retried, duplicated or below coverage. The release target is at least 99% of approved scenario IDs, 100% of critical IDs and 100% pass of executed required tests; the current matrix also requires every registered browser execution, so all 100 IDs must be present. A manually changed `status` cannot substitute for browser evidence. The present `tests/full-e2e/` directory contains twelve provisional ROADMAP-02-A, ECO-01, ECO-02, ECO-03, ECO-04-A and ECO-06-A cases. Despite mapping approval, a release run remains incomplete until every approved case is implemented and exercised. The local/provisional gates retain their separate denominators.

For a full-release ID to pass on one registered browser, its **single first-attempt execution** must complete *every* listed required check. The browser test wraps each check’s action and assertions with `requiredCheck(index, async () => { … })`. That helper records a Playwright step and adds a runtime completion annotation only after the callback succeeds. The release gate compares the exact set of case-ID/index/content-digest annotations on **each** browser execution against the approved register and rejects missing, duplicated or stale checks. A passed marker is a structural completion signal, not proof that an assertion was meaningful: review the actual browser assertions and retained trace against every expected result when implementing the journey. Multiple report entries for the same case/browser remain invalid; a future split into separately countable IDs requires a new version, reviewed denominator and updated exact-inventory guard.

Unit probes deliberately corrupt source coverage and browser reports, including missing mapping, skipped/failed/retried tests, wrong browser, duplicate IDs, missing definition, false completion and an incomplete full-release matrix. The release command can now verify the reviewed mapping, but it cannot accept the local-slice report as input or pass with only the twelve implemented ROADMAP-02-A, ECO-01, ECO-02, ECO-03, ECO-04-A and ECO-06-A cases. Later scope changes must update the version, preserve provenance and record why any case is split or superseded. No passing local gate, documentation review or overlap table completes the member-to-reviewer, payment, participation or other full-MVP cases.

## Provisional ROADMAP-02-A, ECO-01 through ECO-04 and ECO-06-A execution

The separate `tests/full-e2e/roadmap-02.spec.ts`, `tests/full-e2e/eco-01.spec.ts`, `eco-02.spec.ts`, `eco-03.spec.ts`, `eco-04.spec.ts` and `eco-06.spec.ts` suites exercise the proposed `F-ROADMAP-02-A`, `F-ECO-01-A/B/C`, `F-ECO-02-A/B/C`, `F-ECO-03-A/B/C` , `F-ECO-04-A` and `F-ECO-06-A` IDs in desktop and mobile Chromium against the compiled UI, server and a disposable PostgreSQL database separate from the approved local-slice database. ROADMAP-02-A checks cross-member workspace, evidence identifier and stolen-link denial plus staff API denial using two synthetic members. ECO-01 checks exploratory entry, a noncoding exercise and private progress. ECO-02 checks synthetic editor/reviewer-published reading and task-specific rubric versions, private local submissions for technical and non-IT paths, shared preview access and separate truthful specialist readiness. The IT service list remains in preparation because no role-specific qualified content and capacity registry exists. ECO-03 checks retained private versioned work after a goal change, new-goal eligibility, empty eligible content and recovery from an uncertain save. ECO-04-A checks that joining only one local synthetic circle does not disclose a versioned private practice response to another member of that same circle, including through a forged member-ID query. ECO-06-A checks two distinct goal-specific synthetic lesson sources and unsaved local reflection for general and non-IT professional learners without a career path or live provider. `make verify` runs these suites after the approved local slice, preserves Playwright traces for all 24 executions, and records their mapped, first-attempt results under `provisionalFullMvpEvidence` in `artifacts/application-verification.json`. Missing, retried, failed, duplicate or unmapped provisional executions fail the shared gate. The provisional evaluator requires every current `requiredChecks` completion token exactly once in each browser's single first-attempt execution, using the same validation as the full-release evaluator; a missing, duplicated or stale token on either browser fails the gate. The tokens follow substantive browser assertions, but a token alone does not prove the assertions or trace are meaningful; ECO-01's six CI traces received separate review in #163, while ROADMAP-02-A, ECO-02, ECO-03, ECO-04-A and ECO-06-A still need their own evidence review. The report records `approved: false`; the local-slice report still shows **0/100** approved full-MVP IDs, and `npm run verify:full-e2e` still requires all 100 cases. The mapping decision does not promote provisional tests to full-release evidence.
