# Reviewer worklist evidence

Issue [#461](https://github.com/deepnative/deep-native-engine/issues/461); accountable owner @tomqwu; worker /root; claim DNE-2026-10-04-461-root. Private invented-data discovery under #193/#39. Author self-review is not independent or qualified approval.

## Acceptance map

| AC | Evidence | Boundary |
| --- | --- | --- |
| 1: discover existing exact-authorized work | `reviewer-worklist.ts` has no object-storage dependency; real PostgreSQL own-grant test; L148–150 staff navigation and empty-before-grant journey | Listing grants no authority and starts no allocation |
| 2: metadata and own state | Real publication/clarification lifecycle; cursor ordering test; route escaping tests; browser active/completed transitions | No source/comments/member names/other-reviewer drafts in response |
| 3: current scope and withdrawal | Real exact/assignment revoke, consent, quarantine, source deletion, role/session and duplicate-grant cases; existing detail controls unchanged | Purpose grants remain independent of time grants |
| 4: pagination and bounded operation | 105 same-time submissions across three owners, six pages with exact expected ordering; foreign/view/tampered cursors; signed malformed-payload unit tests; actual EXPLAIN | No snapshot guarantee during mutation; no universal scan-cost claim |
| 5: transaction lifetime | Existing bounded `sampleFeedbackTransaction`; actual observed PostgreSQL blocking in both winner orders for exact/assignment revoke, consent and deletion; delayed COMMIT/native release expiry | Entire result withheld on uncertainty, no automatic retry |
| 6: usable honest states | Route 403/422/503/empty tests; L148–150 keyboard desktop/mobile flow and member/outsider denial | Private local sample review, no qualified service or deadline promise |
| 7: audit/rollback | One bounded existing audit insert of IDs/read action; unit assertion excludes title; read-pause config tests; operation guide | No schema, index, queue duplication or grant backfill |

## Measured query and lock design

Acquire reviewer principal/profile SHARE fences, discover at most 21 candidates, then sorted-ID SHARE fences for workspace, evidence, submission, assignment, exact grant and own feedback. Requery every candidate under current predicates and require the same associations; any missing/changed row withholds the whole page. Source/submission fences serialize existing feedback writers. Observe authority before return, through COMMIT and native handback using the existing monotonic bounded transaction helper.

The 105-submission local fixture returned six pages without omissions or duplicates. Each page executed 20 queries; bound assertion allows at most 30, with each selected-ID array at most 21. Actual first-page EXPLAIN ANALYZE returned 21 rows in 0.585 ms. These are local fixture measurements, not a production benchmark or proof that all scanned tuples are bounded. Existing indexes were sufficient for this fixture; no speculative schema change.

## Original failures and corrections

Unchanged verified main ee4e9f8 returned 404 for the required authenticated worklist; cursor and route modules were initially absent and their tests failed before implementation. Focused runner initially used the wrong CommonJS pg import shape and failed before database creation. Fixtures then used invalid background/role enums, attempted a role transition while incompatible assignments remained, and omitted the required consent-revocation timestamp. Corrected fixtures follow existing constraints; no production constraint was weakened. Original logs remain under `/tmp/dne461-*` on the implementation host and dated issue checkpoints preserve their meaning.

## Verification and delivery state

Clean baseline ee4e9f8/tree3e3c3585afc84f8191bc4be300e165e1c5562c9d passed `make verify`; original artifacts preserved in `/tmp/dne461-baseline-original-artifacts`. Original changed-code full gate passed repository73, unit2373, PostgreSQL1561, and approved local browser checks. Its reports are preserved in `/tmp/dne461-changed-original-artifacts`. Six additional integration cases passed in an isolated source-identical snapshot (27/27): future/expired assignment and exact-grant windows, another reviewer’s draft isolation and metadata discovery without object files. A stronger valid200-character title probe failed at1877px content in a390px viewport; scoped worklist wrapping corrected it to390px. The extended actual journey then exposed member evidence-page overflow preventing mobile queue submission; original failed traces are retained and scoped evidence-page wrapping is included. All six corrected desktop/mobile journeys then passed once, including explicit member and reviewer viewport assertions. Final typecheck and lint passed. Clean exact-commit and hosted delivery gates remain required. New worklist modules measured100% S/B/F/L; global unit S7899/7906, B7487/7513, F1594/1594, L7307/7312. Complete changed/exact/pre-push gates and original PR/main CI must be recorded on #461 before claiming delivery. No skipped/flaky/retried checks are accepted as success. Approved local registerv85 extends existing journeys with L148–150; full-MVP remains separately unaccepted.

## Operations and demo

See [the worklist guide](PRIVATE-REVIEWER-WORKLIST.md) for navigation, failure recovery, pause and compatible rollback. A dedicated invented-data verified-main demo must show empty-before-grant, discovery, active/completed/clarification transitions and revoked access, recording revision/date/access/restart instructions and captures on #461. No active test database or private credentials may be used in shared captures. Parent #193/#39 remains open for qualified routing, bookings, actual capacity and service policy.

Next bounded action: finish #461 verification and delivery under its current claim. Recommended lead GPT-6 Astra/XHigh; author design/review High. No model switch or broader acceptance is implied.
