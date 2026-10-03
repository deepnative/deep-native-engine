# Sample-hold private read lifetime and recovery

Issue [#449](https://github.com/deepnative/deep-native-engine/issues/449), under open [CTP-023 #42](https://github.com/deepnative/deep-native-engine/issues/42), fixes private local sample-hold receipt/grant reads returning fields after session expiry during a delayed successful database reply. This is a private invented-data preview outcome, not a real appointment, paid allowance, qualification decision, hosted retention policy or accepted full MVP.

## Member outcome

Members can still reserve an explicitly seeded matching allowance, inspect their own receipt, withdraw a held sample and reload its terminal receipt. Background grants neither minutes nor staff privileges. Expiry during a lock wait, commit reply or handback withholds the entire private receipt/list; the existing unavailable/recovery page replaces private results. A subsequent expired-session request returns to onboarding. An unavailable receipt does not confirm whether a previous write committed. Inspect durable state under current authority before a new action; the reader never automatically retries settlement or commit.

## Lock and lifetime map

[slot-holds.ts](../../src/slot-holds.ts) acquires one owned client within three seconds. Every preparation, query/lock reply and transaction step shares a ten-second monotonic operation budget and five-second stage limit. Server statement/lock timeouts are explicitly five seconds; the final transaction receives the remaining whole-operation timeout.

Before initial receipt reads or lazy settlement, a validated database observation supplies remaining session duration. Conservatively charge its entire query/reply duration. Use monotonic elapsed time, not host wall-clock time; a later observation can shorten but never extend this read's lifetime. Missing/malformed observations withhold data. Timer rounding can conservatively deny just before the database deadline; it cannot add access time.

Initial owned receipt reads and atomic lazy settlement execute outside the final transaction, preserving settlement's slot-before-member writer order. The final read locks the current principal, then its owned non-deleting workspace, before owned receipt/grant projection and another authority observation. Fences preserve existing read/mutation winner order through commit. They do not claim atomic HTTP delivery with a later revocation or a common locking scheme for every domain. Expiry advances without a row mutation, so duration also covers commit reply and resource handback.

All preparation uses this owned client, replacing pool-managed initial reads/settlement. The client is deliberately discarded on every handback, including success, preventing its session timeout configuration from leaking to reuse. This adds connection churn; no production throughput, universal SQL scan bound or pagination redesign is claimed. Existing receipt query scope/order is unchanged.

## Failure and accounting boundaries

| Boundary | Behavior |
| --- | --- |
| Acquisition never resolves or arrives late | Withhold; discard any late client without reading |
| Preparation/query/settlement exceeds stage or cumulative budget | Withhold; discard; never queue rollback behind a pending reply |
| Missing/malformed authority or expired reply/handback | Withhold the whole private receipt/list, including grants |
| Known read error in an open transaction | Bounded rollback if safe, then discard; no private payload |
| Issued COMMIT with lost/nonresolving reply | No replay or queued rollback; discard; fresh authorized inspection establishes durable state |
| Known successful commit followed by late/failed handback | No rollback after commit; no private payload |
| Earlier atomic lazy settlement committed before a later read failure | Preserve durable settlement; fresh reads neither duplicate accounting nor revive expired units |

Disposal releases actual server-side fences so independent revocation/deletion and unrelated member reads can progress. Successful terminal reads and denied reads do not rewrite retained receipts, holds, grants or events. Lazy due-hold settlement can legitimately commit before a later read is withheld; withholding is not a claim that settlement was undone. No grant/reset, provider, payment or commercial booking policy is introduced.

## Acceptance evidence and delivery trace

- Original unchanged clean main `994a0efaa73a8824ee6a3cffde837ff78741d88e` passed the full baseline: repository 73, unit 1,915, PostgreSQL 1,379, approved local 135/135, critical 134/134, 270 desktop/mobile executions. Global S99.91/B99.61/F100/L99.93; every executable module >=99%. Accepted full-MVP remains separately 0/100, critical 0/94.
- Against unchanged source, actual isolated PostgreSQL and actual HTTP receipt/list probes returned private fields after a delayed otherwise-successful commit crossed expiry. Final authority was valid; event accounting unchanged. Original reports/logs `/tmp/dne449-real-pg-fail-first-original.*` and `/tmp/dne449-real-http-fail-first-original.*` remain retained. The focused unit late-commit regression failed for both methods too. These are defect evidence, not passed gates.
- [Deadline unit cases](../../tests/unit/member-slot-read-deadlines.test.ts) cover all preparation/resource/observation/uncertainty stages, conservative lifetime and clock skew. [Existing behavior tests](../../tests/unit/member-slot-holds.test.ts) preserve exact identity, settlement ordering, ownership and write recovery.
- [PostgreSQL/HTTP cases](../../tests/integration/member-slot-holds.test.ts) cover delayed successful commit and native-client handback across database expiry, actual principal revocation/workspace deletion winner orders, lock expiry, committed lazy-settlement reply loss, fresh one-time recovery and nonresolving driver replies with actual lock release. Existing isolation/accounting/corruption cases remain.
- [Browser cases](../../tests/e2e/member-slot-read-expiry.spec.ts) add L136–L138 for general, other-professional and IT learners on both approved Chromium projects: actual onboarding, keyboard hold/withdraw/reload, a real PostgreSQL principal lock wait across expiry, no private fields and keyboard recovery. `initial-learning-v81` retains all 135 prior local IDs and the exact separate full-MVP inventory. Local coverage is not qualified or full-MVP acceptance.

The first clean implementation revision `da800f1b73c96894a1f888669d144c4b98680f08` passed its original complete gate: repository 73, unit 1,938, PostgreSQL 1,393, local journeys 138/138 (critical 137/137), browser 276 + 6 cross-browser + 68 provisional, no skipped/flaky/retried cases, all module unit metrics >=99%. Raw reports are retained in `/tmp/dne449-exact-da800f1-original-artifacts`. Author acceptance review then added two real PostgreSQL handback cases to satisfy AC3 directly; the final revision must independently pass the full gate and delivery procedure.

The additional original-reader handback probe used source extracted from Git at `994a0ef`, otherwise unchanged fixture modules, an isolated generated database and actual native client release followed by a delayed synchronous return. Both methods disclosed private data after expiry with a known commit and unchanged accounting. `/tmp/dne449-real-handback-fail-first-original.json` retains the observations; its subsequent cleanup emitted `57P01`, retained separately in the original log. This probe is defect evidence, not a passed verification gate. The committed regression cases prove known commit before expiry, denied handback after expiry, no post-commit rollback and exact durable accounting/fresh recovery.

Original failures and fixes remain separate: default system Python lacked `tomllib`; supported runtime bootstrap/baseline then passed. New deadline tests caught acquisition invocation preceding its timer; invocation was moved inside the bounded operation. Older doubles needed DB duration fields, owned initial reads and final-fence pause; their ownership/race/failure assertions remain. Initial focused PostgreSQL failures also exposed conservative timer rounding versus uncertainty; authority-limited timers now retain denial classification. Reports are retained without hidden retry, skip, threshold change or denominator reduction. Final clean revision, exact verification, unbypassed pre-push, author self-review, original CI, guarded merge, main CI, cleanup and actual demo are recorded on #449; working evidence alone establishes none of them.

## Rollback and actual milestone

Rollback restores the old reader and reopens this expiry/late-reply privacy defect. No schema or persisted grant/event/reservation/history rewrite is required or permitted. Preserve durable accounting; do not manually reverse an uncertain operation.

After verified main, demonstrate held→withdrawn→reloaded receipt and expired-session recovery in a separate dedicated invented-data PostgreSQL/storage preview. Record actual revision, Toronto date, deterministic provider state, actions/outcomes, captures, local access and restart/lifetime in the issue closeout. Do not use a quality-gate database or expose cookies/credentials. Parents #42 and #29 remain open for their broader matrix, qualified capacity, booking and commercial decisions.
