# Phase B release report

Issue [#44](https://github.com/deepnative/deep-native-engine/issues/44) (CTP-024). Written 11 November 2026 for main `49713a7d` (tree `4e3adbbf`). This report is the only change after that revision; the gate result for the commit that adds it is in the #44 close-out.

**Result: Phase B is built and rehearsed as a demo with invented data. It is not accepted as a release, and launch is no-go.** The automated register passes in full. An independent review of the 100 full-MVP browser tests found that six of them do not prove what their case requires. Nothing here was checked with real members, real experts, a real AI provider, payment processing or a signed-in session on the hosted site.

## What this report does not establish

Read these before any number below.

- **Invented data only.** Every person, amount, submission and file in every test and walk is invented. No real member has used the product.
- **Simulated AI.** AI answers come from a deterministic local simulation. No live AI provider is connected ([#783](https://github.com/deepnative/deep-native-engine/issues/783), parked), so provider faults, real cost and real output quality are untested.
- **No real experts.** Reviewers, coaches, moderators and operators in tests are invented staff accounts. There is no expert roster, booking engine or staffed response time ([#784](https://github.com/deepnative/deep-native-engine/issues/784), parked).
- **No formal assessment or appeal** ([#648](https://github.com/deepnative/deep-native-engine/issues/648), parked). Feedback is one reviewer's private comment.
- **No payment processing.** Deep Native Inc. issues invoices; payment is offline and in full, and staff record it by hand. No card or bank is ever charged, and there are no cancellation or refund rules (students write to info@deepnative.io).
- **No signed-in hosted run.** Workers never sign in on engine.deepnative.io. The hosted demo was checked signed out only, after each deploy. [#97](https://github.com/deepnative/deep-native-engine/issues/97) and [#545](https://github.com/deepnative/deep-native-engine/issues/545) were closed on automated evidence without a signed-in hosted demonstration.
- **Self-review.** Each change was reviewed by the worker that wrote it. The only independent reviews are of the full-MVP case wording and of the 100 full-MVP tests (below).
- **Not legally reviewed.** The terms and privacy text is accepted for the demo only ([#12](https://github.com/deepnative/deep-native-engine/issues/12)).
- **Backups.** The 30-day backup period is decided but not yet applied in Azure. No production restore has been rehearsed ([#45](https://github.com/deepnative/deep-native-engine/issues/45)).
- **Browsers.** The register runs on desktop Chromium and Pixel 7 (Chromium). Firefox and WebKit run the accessibility spec only.

## What was run

All on commit `5df88b07`, whose tree is the tree of main `49713a7d`, in the shared Linux gate container (Node 24.21.0, PostgreSQL 18.6, Playwright 1.63.0), first attempt, no retries.

| Check                                                   | Result                                                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests with coverage                                | 6223 of 6223 passed. Statements 99.93%, branches 99.76%, functions 99.97%, lines 99.96% (each must be at least 99%)                                 |
| PostgreSQL integration tests                            | 3351 of 3351 passed                                                                                                                                 |
| Local journey register, desktop Chromium and Pixel 7    | 666 of 666 passed: 333 of 333 journeys on both sizes, none skipped or flaky                                                                         |
| Firefox and WebKit accessibility checks                 | 6 of 6 passed                                                                                                                                       |
| Full-MVP tests in the ordinary gate (provisional stage) | 200 of 200 passed                                                                                                                                   |
| Formal full-MVP release run (`npm run verify:full-e2e`) | 100 of 100 cases, 94 of 94 critical, 200 executions, nothing uncovered. Run `9b6e6308-fc2d-49a5-93a1-b6680520e413`, report sha256 `347006bc…be2b12` |
| Production build and dependency audit                   | Passed; no high-severity finding in production dependencies. GitHub lists one moderate dependency alert on the repository, not looked into here     |

The local register has 333 journeys, 321 of them critical. The full-MVP register has 100 cases in 27 requirement families, 94 of them critical, under mapping digest `686cb90f…`. Coverage here means distinct passing scenario IDs out of all approved IDs.

"First slice alone fails this gate" holds: the release runner takes no outside report, and it fails if any of the 100 cases is missing, skipped, failed or retried on either browser. Its first run on 11 November failed (196 of 200) for a missing test-clock setting and is recorded in [QA-002](QA-002-JOURNEY-TRACEABILITY.md#first-full-release-runs-11-november-2026-utc).

## Independent review of the 100 full-MVP tests

Ten read-only reviewers read all 100 tests on main `1a641e88` on 11 November 2026 and judged whether each test proves every required check or could pass with the product broken. They ran nothing and changed nothing. The result is on [#94](https://github.com/deepnative/deep-native-engine/issues/94#issuecomment-6803283598).

|                         | Cases |
| ----------------------- | ----- |
| Reviewed                | 100   |
| Judged fully sound      | 68    |
| With a blocking finding | 6     |
| With weak findings only | 26    |

**The evidence is not yet accepted.** The 100 of 100 run stands as a technical result, but six passing tests do not prove a required check:

- **F-BUILD-01-D:** the unverified demo expert is ineligible for four reasons at once, so the test would still pass if the product stopped requiring verification.
- **F-BUILD-06-B and F-ROADMAP-05-D:** the "insufficient evidence" sentence the tests look for is fixed text on every practice page. The product has no feedback specific to a sparse answer, so these two cases may be unmet in the product, not only in the test.
- **F-BUILD-08-C:** no AI-derived record exists when the deletion runs, so the test does not show that deletion removes one.
- **F-ECO-05-A:** the early publish request is refused for a missing Origin header, before the publication rule runs.
- **F-ROADMAP-05-B:** the request past the conversation limit is refused as a malformed form, not for the limit.

The fixes, and the tightening of the 26 weak tests, are queued on #94. Until they merge and the run is repeated, the honest count of soundly proven full-MVP cases is 68 of 100, with 26 more proven with reservations. The reviewers did not treat the limits listed at the top as findings.

## Rehearsal walk

A scripted Playwright walk on main `49713a7d`, 11 November 2026 18:36–18:37 UTC, on a local listener in test mode with one throwaway in-memory database, plus a second listener on the same database with configured Deep Native Inc. invoicing. Desktop Chrome (1280) and Pixel 7, a separate browser context per actor, a sideways-scroll check and a full-page screenshot on every page. The script is not committed. Nothing was done on the hosted site.

| Walk                                                                                                                                                                                                                                                                                                                  | Desktop | Pixel 7 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| Signed out: home, terms, workflows, programs and the email sign-in page open; My courses, coaching, Download my records and every staff page are refused (401, 303 or 403)                                                                                                                                            | OK      | OK      |
| Three people join as an IT practitioner, a professional in another field and a general learner, and each reaches their own learning space                                                                                                                                                                             | OK      | OK      |
| A member opens the starter lesson, a library lesson and 38 member pages: progress, milestones, practice, evidence, assignments, circles, contributions, events, support, availability, readiness, programs, My courses, account, billing, sharing, allowances and notebooks                                           | OK      | OK      |
| An administrator saves the student's coaching terms (CAD 1,500.00, 90 review minutes, 4 sessions, 25 AI requests); the student sees them on My courses and on the coaching page                                                                                                                                       | OK      | OK      |
| "Your coaching" on My courses lines up with the page heading (x 34 on desktop, 20 on Pixel 7), so the earlier indent is gone                                                                                                                                                                                          | OK      | OK      |
| The student saves a billing recipient; the administrator issues the invoice from Deep Native Inc. with HST (13%), total CAD 1,695.00, records an offline payment, and the balance is CAD 0.00                                                                                                                         | OK      | OK      |
| A platform administrator opens 17 staff pages; `/admin` answers "Administration unavailable" (403) to a local staff credential, because it has its own administrator entry. An operator, editor, reviewer, moderator and coach each open their own page, and the operator is refused the administration console (403) | OK      | OK      |
| Download my records returns format v50 with 78 sections                                                                                                                                                                                                                                                               | OK      | OK      |
| The student deletes the account; the administrator then gets "Student account not found" (404) for that student, and the issued invoice is still there                                                                                                                                                                | OK      | OK      |

82 page visits on each size. No page scrolled sideways and none returned a server error. I looked at the Pixel 7 screenshots of My courses and the paid invoice myself.

The walk is shallow next to the automated register: it opens pages and follows one coaching and billing path. Submitting an assignment, private feedback, circle discussion and moderation, simulated AI practice, support and events were not repeated by hand; they rest on the 333 journeys and 100 cases above, which run on both sizes.

## State of each capability

"Local test" is what the gate exercises. "Hosted demo" is what engine.deepnative.io is configured to do; it shows the "Demo site · Test data only" banner on every page.

| Capability                                      | Local test                                                | Hosted demo                                    | Real or live                                          |
| ----------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Join, return, learn, save progress              | Tested                                                    | On                                             | No real members; hosted sign-in email was not checked |
| Foundation lessons and assignments              | Tested with the reviewed version 2 pack                   | On                                             | Editorial review only; no qualified sign-off          |
| Assignment submission and private feedback copy | Tested                                                    | On                                             | No real reviewers                                     |
| AI study help and practice                      | Tested with simulated AI                                  | Simulated only (demo mode)                     | No live provider (#783)                               |
| Learning circles, reports and moderation        | Tested                                                    | On                                             | No staffed moderation                                 |
| Member contributions                            | Tested                                                    | On                                             | Contact is info@deepnative.io; no staffed review time |
| Events and attendance                           | Tested                                                    | Registration and scheduling on; attendance off | No real events                                        |
| Support requests                                | Tested                                                    | Staff assignment on; member intake off         | No staffed support                                    |
| Per-student coaching terms and allowances       | Tested                                                    | On                                             | Set by an administrator; no real students             |
| Invoices                                        | Tested, sample and configured (Deep Native Inc., 13% HST) | Sample only: not payable, no email sent        | No real invoice issued                                |
| Payments                                        | Staff-recorded offline payments tested                    | Same                                           | No payment processing, by owner decision              |
| Expert sessions and booking                     | Sample holds only                                         | Sample holds only                              | No booking engine, no experts (#784)                  |
| Formal assessment and appeal                    | Not built                                                 | Not built                                      | Parked (#648)                                         |
| Download my records and account deletion        | Tested                                                    | On                                             | Hosted storage and backup erasure not reconciled      |
| Staff sign-in                                   | Tested with local staff credentials                       | On                                             | No production identity provider                       |

## Open defects and gaps

No release-blocking product defect is open from the gate, the release run or the walk. Open items:

- **Six full-MVP tests with a blocking finding, and possibly no sparse-answer feedback in the product** (F-BUILD-06-B, F-ROADMAP-05-D). Queued on #94.
- **Metrics disclosure.** A reviewed production disclosure policy and a repeated-snapshot inference check were never done (QA-004 row M17). No issue is parked for this; it needs the privacy review on #12 before real data.
- **Nothing checked at all** for AI context injection (QA-004 M11, #783) and the formal review transaction (M22, #648), because neither exists.
- **Cosmetic, not fixed:** on Pixel 7 the "Local enrollment simulation" note on My courses has no gap under the header line, and the invoice's payment table is wider than the screen and scrolls inside its own box.
- **Human coverage:** no reviewer, coach, moderator, operator or support person is staffed. info@deepnative.io is the only contact. No response time is promised.

The final state of each risk row is in [QA-004](QA-004-RISK-TEST-MATRIX.md#final-state-of-every-row-11-november-2026).

## Acceptance criteria of #44

| Criterion                                                                                                  | State                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run all applicable source journeys plus ECO-01 to ECO-08 for IT, non-IT professional and general learners  | Done with invented data: the full-MVP register covers the ROADMAP, BUILD and ECO families, and the walk used all three starting points. Six cases are not soundly proven (review above).                          |
| Desktop, mobile and keyboard checks cover complete flows                                                   | Desktop Chromium and Pixel 7 cover every journey. Keyboard is covered only by L53 and the accessibility spec ([QA-005](QA-005-LOCAL-KEYBOARD.md)); the owner excluded wider accessibility work from this release. |
| Report live, test, manual and disabled state separately; defects and human-coverage gaps explicit          | The tables above.                                                                                                                                                                                                 |
| First slice alone fails this gate                                                                          | Yes, see above.                                                                                                                                                                                                   |
| At least 99% journey coverage, 100% critical, all required tests passing, at least 99% on each unit metric | Met by the automated counts above. The review means "passing" is not the same as "proven" for six cases.                                                                                                          |

## What a release would still need

1. Fix the review's blocking findings and re-run ([#94](https://github.com/deepnative/deep-native-engine/issues/94)).
2. The owner's decision on accepting the full-MVP evidence with its limits (#94).
3. Launch prerequisites: legal review of the terms, the Azure backup setting, a production restore rehearsal and hosted storage reconciliation (#12, #45).
4. A signed-in demonstration on the hosted site by someone allowed to sign in there.
5. Decisions to unpark live AI (#783), real experts (#784) and formal assessment (#648), if they are wanted.

This report is evidence for the Phase B gate ([#3](https://github.com/deepnative/deep-native-engine/issues/3)). It is not a launch decision.
