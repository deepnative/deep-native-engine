# Private local requests using test units

On **Private evidence → Choose an invented sample for local AI simulation**, save an invented text sample, complete its local safety check, and grant permission for that exact version. **Use one local test request** is a separate confirmed action that holds one already seeded study request. **Run local test request** completes the deterministic simulation and consumes that unit once. The original **Queue local simulation** remains unmetered.

The server selects the earliest-expiring eligible owned study grant, breaking ties by grant ID. An empty or wrong-category balance denies the action without creating a job, reservation or allowance. The fixed policy is `deterministic-request-test-v1`: one study request per job, one dispatch claim. It is not a price, token estimate, membership quota, purchased service or live provider integration.

Reloading a receipt shows a held, consumed or released test unit. Replaying the same request key returns its same job without another hold. Changing the source contract or switching between metered and unmetered requests conflicts. One unresolved job per exact receipt/purpose fences new requests across both paths.

Withdraw exact-source permission before dispatch to release a held unit once. Creating a source revision or deleting the source does the same for never-claimed requests. After the grant deadline, release records expiry rather than restoring usable units. A committed dispatch claim with an unknown outcome remains held and cannot retry or refund automatically, even after withdrawal or source deletion. The broader reconciliation decision is separate work on #189.

Open **See your local test units** to inspect the current owned balance and download its summary. The summary contains quantities rather than raw event/reservation IDs. The existing v15 private record export retains its safe owned job whitelist; this change adds no raw ledger export or provider output. Source deletion removes receipt/source bytes and retains content-free accounting linkage. Full member deletion erases all owned jobs, links, grants, reservations and events while preserving other members.

## Transactions and migration

Migration 053 adds an immutable owned job/reservation link and policy, validates category/quantity/local job identity, and enforces job/reservation outcome agreement. Legacy jobs acquire no link, inferred allowance or charge. Reapplying migrations preserves populated legacy and metered history. The composite job/member index adds storage; index creation and foreign-key replacement/validation take PostgreSQL table locks and can wait behind active writers. Apply with affected workers stopped and allow for the retained job/reservation table sizes; no production performance or online migration is claimed.

Queue insertion, reservation and its immutable event share one caller-owned transaction. The durable dispatch claim commits before computation; final result, consumption and its event share another transaction. Shared connection-bound ledger operations neither open a second pool connection nor commit independently. Generic settlement cannot spend or release linked local-job reservations. Receipt/revision/deletion cancellation uses the same database release accounting as the ordinary ledger. Final session, grant and dispatch-lease deadlines withhold late or uncertain results; pool/COMMIT faults disclose no private error or optimistic success.

## Non-destructive rollback

Use the existing platform-admin local pause control to disable both queue and dispatch. Stop active local workers before changing application versions. Keep migration 053, its constraints, linkage and ledger restrictions in place; retain pending, consumed and uncertain history. Do not downgrade to a worker that does not understand metered links, drop populated tables, reset claims, refund held dispatched units, or delete events. Resume the compatible application only after reviewing the issue's verification evidence; resuming does not redispatch an uncertain claim.

The delivery scope is [#437](https://github.com/deepnative/deep-native-engine/issues/437), under open parent #188. Local fixtures and deterministic simulation evidence do not establish live provider consent, financial approval, qualified review or full-MVP acceptance.
