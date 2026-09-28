# Local administrator revocation and grant mutation ordering

Scope: [CTP-023 #332](https://github.com/deepnative/deep-native-engine/issues/332), a bounded [CTP-023 #42](https://github.com/deepnative/deep-native-engine/issues/42) / QA-004 M03 slice. All fixtures are synthetic. This does not complete either parent or establish hosted identity, private-MVP acceptance or launch readiness.

## Reproduced failure

On unchanged application source at `c1eacd2343ce3fbf7ee1ca80182bc3313fa08977`, the first attempt at six real-PostgreSQL cases failed: while one connection held an uncommitted administrator `revoked_at` update, a second connection created or revoked an assignment, support or exact-evidence-review grant without waiting. Every operation persisted both its grant mutation and success audit event. The test commits the prior revocation and checks the returned outcome, blocking state and persisted rows together.

The original log, JSON result and six-case test snapshot are preserved in the delivery checkout as `artifacts/332-first-failure.log`, `artifacts/332-first-failure.json` and `artifacts/332-first-failure-test.ts`. The command was `npx vitest run --config vitest.integration.config.ts tests/integration/admin-grant-race.test.ts`, using a separately generated `dne_test_<32 hex characters>` database through `DNE_TEST_DATABASE_URL`; the harness drops that database afterward. No application patch preceded this reproduction.

## Lock order and authorization boundary

Each existing single-statement grant create/revoke operation now checks the administrator with `FOR SHARE OF p`, then writes the grant, then its content-free success audit event. The principal lock lasts until the same transaction commits or rolls back. Revocation's non-key principal update conflicts with this shared lock; the foreign-key key-share lock alone did not provide that protection. Under the application's PostgreSQL Read Committed isolation, a grant check waiting behind committed revocation re-evaluates the updated principal and denies. Under stronger isolation a changed row may instead produce a safe serialization failure. See PostgreSQL's [row-level lock modes](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS) and [Read Committed behavior](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED).

The statement keeps its existing eligibility predicates, role/scope boundaries, return values and atomic audit. This adds no principal-management endpoint, permission, audit payload or provider integration. Principal revocation takes the principal lock first; any future combined principal/grant administration must preserve that order. No new application-wide timeout policy is introduced.

## Behavioral evidence

`tests/integration/admin-grant-race.test.ts` contains 51 behavioral cases using distinct PostgreSQL connections, explicit transaction barriers and `pg_blocking_pids` observations:

- All six grant operations wait behind principal revocation; commit denies without a mutation or success audit, while revocation rollback permits the waiting operation.
- All six operations hold off principal revocation until their mutation/audit transaction commits or rolls back. An observer sees neither partial grant state nor a partial audit event. Operations after committed revocation deny.
- Concurrent duplicate grant revocations produce exactly one successful transition and audit for each grant type.
- Injected grant-write and audit-write failures roll back state, release principal locks and permit a later valid operation for all six operations.
- A bounded lock timeout fails safely and recovers after rollback for all six operations. Blocking observation is bounded to two seconds and worker statements to five seconds; no tested schedule demonstrated a deadlock.
- Member, coach, reviewer, editor, moderator and operator callers, and revoked, expired or nonexistent administrators, remain denied for every operation. Success audits have exactly the existing content-free fields.

The first corrected focused run passed 51/51, alongside type checking. Complete repository verification and exact-commit/PR/main evidence are recorded by the delivery handoff; focused results alone do not establish those gates. The existing E2E scenario denominator and full-MVP outstanding scope are unchanged.
