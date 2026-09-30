# Assignment mutation expiry under PostgreSQL locks

This is a bounded private synthetic regression slice under [CTP-023 #42](https://github.com/deepnative/deep-native-engine/issues/42), claim `DNE-2026-09-29-42-assignment-expiry-builder`. It covers assignment start/return, draft save, local submission and revision. It does not establish qualified review, accepted full-MVP coverage, hosted identity, deployment or commercial readiness. The broad threat matrix and other #42 acceptance criteria remain open.

## Reproduced defect

On unchanged application source at `b58a3765f76de267082a99193193c0d939e250ca`, five first-attempt real PostgreSQL tests failed. Only the new test file differed from the baseline. Each test held a specific lock, observed the waiting operation in `pg_stat_activity`, proved `xact_start < expires_at <= clock_timestamp()` using PostgreSQL, then released the lock. No arbitrary sleep or assumed concurrent winner established expiry.

- A new start blocked by an insert trigger returned an ID and retained a new attempt after expiry.
- Returning to an existing row blocked on that row still returned its ID after expiry.
- Saving changed the response, saved timestamp and revision after expiry.
- Submitting changed submission state and inserted an immutable snapshot after expiry.
- Revising cleared response/saved/submitted state and increased the revision after expiry.

The assertions separately compare all durable attempt fields and submission snapshots. The existing-return case changes no durable values but must not acknowledge authorization after expiry. `CURRENT_TIMESTAMP` in the original autocommit mutations was fixed before the wait.

The reproduction ran with Node 24.21.0 and a generated isolated PostgreSQL database:

```sh
npm run test:integration -- tests/integration/attempt-expiry.test.ts
```

The coordinator retained the first failure log as `/tmp/dne-assignment-reproduce.log` and the corresponding JSON as `/tmp/dne-assignment-reproduce-results.json`. The local wrapper `/tmp/dne-assignment-focused.mjs` creates/drops only a random `dne_test_<32-hex>` database and supplies `DNE_TEST_DATABASE_URL` to that command. These machine-local files are not portable release evidence; subsequent exact-commit gate and CI artifacts establish the delivered revision.

## Repair and invariants

All four mutation paths now share a read-committed transaction. They acquire the active member principal and non-deleting workspace shared locks before the existing assignment mutation, matching owner export and deletion lock order. They check PostgreSQL wall time against the locked principal expiry after the complete mutation, including conflict handling and snapshot insertion, and roll back instead of acknowledging a late result.

The existing assignment version, eligibility, revision, saved-response, submission-limit and ownership predicates remain unchanged. Valid concurrent starts still return one attempt; stale saves do not overwrite newer drafts; submissions and snapshots remain atomic. Database errors continue to propagate to the existing unknown-outcome browser recovery instead of becoming a claimed successful write. Uncommitted transactions roll back, and a failed rollback discards the connection. A commit acknowledgement is required before returning success.

No migration or provider change is required. Rolling back this source change would restore the demonstrated race; there is no data migration to reverse.

## Scoped acceptance evidence

| Criterion | Evidence and observed result | Remaining delivery work |
| --- | --- | --- |
| Reject all five reproduced late operations without durable changes | `tests/integration/attempt-expiry.test.ts`; 5/5 passed after repair | Clean commit and CI gates |
| Expiry across principal, workspace and snapshot waits | Same file; observed locks and durable state assertions, including rollback of submitted state and snapshot | Clean commit and CI gates |
| Valid waits, outsider, revoked and deleting workspace behavior | Same file plus existing `tests/integration/store.test.ts`; combined focused run 141/141 passed | Clean commit and CI gates |
| Commit acknowledgement, failed mutation/commit/connection and failed rollback | `tests/unit/attempts.test.ts`; focused 24/24 passed | Full exact revision gate |
| Browser denial preserves copyable attempted text and old durable state | Existing L51 now includes both expiry during an observed row wait and the original pre-request expiry; desktop/mobile 2/2 first-attempt passes | Full browser matrix on exact revision |

The approved local register extends L51 without adding or removing IDs. With the independently delivered L92 evidence-export journey retained, the combined register is `initial-learning-v63`: 92 approved local scenarios, including 91 critical; full-MVP acceptance remains 0/100. The version records both mandatory behaviors without dropping either scope.

Full unit coverage on this working implementation passed with 3705/3705 statements, 3469/3483 branches (99.59%), 810/810 functions and 3487/3487 lines; the attempts module is 100% on every metric. No threshold, source exclusion, scenario denominator, retry or skip was changed.

Environment setup failures are separate from test results: the first bootstrap used an older system Python without `tomllib`; Python 3.12 completed bootstrap. The first full baseline gate failed before application validation because the new checkout had no installed dependencies; all 58 repository checks passed. `npm ci` restored the existing lockfile. Node 24.21.0 was used for the subsequent focused checks. No dependency version changed.

The coordinator will record the clean exact-commit gate, reviewed PR head/base, PR CI, merge SHA, resulting-main CI and cleanup in the live issue/PR before delivery is declared complete. The next bounded action is review and delivery of this claimed #42 slice, after incorporating any moving-main change. Lead: GPT-6 Astra/XHigh; separate source review when requested: Astra/High. This handoff does not claim or authorize another backlog slice.
