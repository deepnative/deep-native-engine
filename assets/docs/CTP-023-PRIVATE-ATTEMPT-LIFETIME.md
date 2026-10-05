# CTP-023 private assignment-attempt lifetime

[Delivery #471](https://github.com/deepnative/deep-native-engine/issues/471), parent [#42](https://github.com/deepnative/deep-native-engine/issues/42). Accountable owner Tom Wu / @tomqwu; worker `/root`; author self-review, not independent or qualified approval. Explicit scope is the private-local lifetime and recovery outcome recorded on #471. All data and providers in these checks are invented/local. No migration, deployment, live provider or public session-renewal feature.

## Reproduction and candidate evidence

On 5 October 2026, unchanged main `ee24c6b156c09904a27ea72c1c745902ca228b51`, tree `315cc82109b225d9258a7a3501905f4f7946aba7`, passed the clean full baseline: 73 repository checks, 2,378 unit tests, 1,630 PostgreSQL checks, 324 approved local browser executions, six keyboard matrix executions and 68 separately identified provisional executions. Environment: macOS, Node 26.9.0, Python 3.12.14; locked dependencies installed after bootstrap.

The first permanent HTTP suite preserved 18 failures on that source: all nine operations at delayed successful COMMIT/native handback. Expired writes returned a success redirect; expired reads returned private content. Four additional direct comparison/portfolio cases also failed on unchanged source, including an expired portfolio attachment. These focused selections are reproduction evidence, not full gates; their non-selected tests do not change any approved denominator.

| Scoped acceptance | Behavioral evidence | Delivery boundary |
| --- | --- | --- |
| Actual expiry defect and durable outcomes | `attempt-lifetime.test.ts` exercises all nine operations through HTTP at successful late COMMIT/handback, observes database expiry, verifies the committed row/history and fresh-read equality. Direct comparison and portfolio checks also withhold private text/attachments. | Retain original failures; full exact-head gate remains required. |
| Bounded lifecycle and disposal | The same PostgreSQL suite stalls query, COMMIT and rollback for each operation, asserts disposal and no queued COMMIT/rollback/replay, and tests real exhausted/late acquisition without a subsequent query. | Existing shared transaction engine remains unchanged. |
| Safe recovery | Fixed 503 page exposes neither retained text nor private error cause, offers a fresh current-attempts read and has no replay form or false failure receipt. Meaningful unit HTTP and actual PostgreSQL cases cover the distinction. | Definite pre-commit denial and ordinary eligibility/revision conflict remain distinct. |
| Retained privacy/concurrency | Existing attempt-expiry, member-export/deletion, assignment-reflection and comparison suites pass 53 focused checks after updating two old error expectations to the explicit sanitized unconfirmed contract. | Historical rows, exact snapshots, locks and owner isolation remain; no migration. |
| Meaningful unit gate | Candidate complete unit run passes 2,379 tests and global/per-file gates: statements 99.91%, branches 99.63%, functions 100%, lines 99.93%. | Exact committed full-gate raw metrics are recorded separately on the live issue/PR. |
| Real browser recovery | L163–L165 pass all six desktop/mobile executions: start/save/submit/reflection save/reflection deletion/revise/removal, normal and uncertain writes, retained history, authorized fresh reads/reloads and no duplicate durable records. | Approved register advances to `initial-learning-v89` without removing prior scenarios or full-MVP requirements. |

## Preserved failures and fixes

Old unit mocks lacked the new database remaining-lifetime observation, producing 39 failures and seven unhandled errors; their contracts then exposed nine obsolete rollback expectations. Mocks now supply actual observation shape, and assertions require disposal without queuing rollback after expiry or issued uncertain COMMIT. A complete candidate unit run passed all tests but initially failed the per-file app branch gate at 98.96%; adding an actual HTTP private-read recovery case resolved it. No coverage exclusion, denominator, threshold or retry was changed.

The first new browser fixture omitted the catalog store, so the first journey timed out with no assignment-start button. Its failure/trace was retained, the next identical fixture execution was interrupted, and four tests did not run. The corrected fixture wires the real catalog store; the complete six-test candidate suite passes without retries. This interrupted development run is not full-gate acceptance. The retained race suite initially exposed two old expectations for raw database error/false timeout; they now require the sanitized unconfirmed outcome and continue to verify durable state and lock ordering. Original failures and raw reports are retained in the delivery environment and linked from the issue's evidence comments.

## Complete delivery and demo

The live issue/PR records the exact commit/tree, clean `make verify`, unbypassed pre-push gate, original push/PR CI, expected-head merge and resulting-main CI, then actual invented-data preview actions, captures, revision/date/provider state, restart instructions and safe merged-branch/worktree cleanup. Candidate tests above alone do not establish those steps; do not close the issue until they are evidenced. Parent #42, accepted full-MVP and qualified approval remain separate.

[Member recovery guide](PRIVATE-ATTEMPT-RECOVERY.md) describes the usable behavior and rollback. Pause/drain affected routes before code rollback, retain possibly committed changes, never automatically replay, and keep old affected handlers unavailable because they reopen the reproduced defect. No schema rollback or historical-row rewrite is required.

Next bounded action is #471's clean exact-commit delivery gate and author review, followed by CI-verified merge and actual isolated demo. Lead GPT-6 Astra / XHigh; design/author review High. This recommendation does not change the running model or claim another issue.
