# Private local requests using test units

On **Private evidence → Choose an invented sample for local AI simulation**, save an invented text sample, complete its local safety check, and grant permission for that exact version. **Use one local test request** is a separate confirmed action that holds one already seeded study request. **Run local test request** completes the deterministic simulation and consumes that unit once. The original **Queue local simulation** remains unmetered.

The server selects the earliest-expiring eligible owned study grant, breaking ties by grant ID. An empty or wrong-category balance denies the action without creating a job, reservation or allowance. The fixed policy is `deterministic-request-test-v1`: one study request per job, one dispatch claim. It is not a price, membership quota, purchased service or live provider integration.

Reloading a receipt shows a held, consumed or released test unit. Replaying the same request key returns its same job without another hold. Changing the source contract or switching between metered and unmetered requests conflicts. One unresolved job per exact receipt/purpose fences new requests across both paths.

Withdraw exact-source permission before dispatch to release a held unit once. Creating a source revision or deleting the source does the same for never-claimed requests. After the grant deadline, release records expiry rather than restoring usable units. A committed dispatch claim with an unknown outcome remains held and cannot retry or refund automatically, even after withdrawal or source deletion. An explicitly assigned current operator can use [read-only hold inspection](PRIVATE-LOCAL-AI-HOLD-INSPECTION.md) to see content-free local metadata; this does not resolve the hold. The broader reconciliation decision is separate work on #189.

Open **See your local test units** to inspect the current owned balance and download its summary. The summary contains quantities rather than raw event/reservation IDs. The existing v15 private record export retains its safe owned job whitelist; this change adds no raw ledger export or provider output. Source deletion removes receipt/source bytes and retains content-free accounting linkage. Full member deletion erases all owned jobs, links, grants, reservations and events while preserving other members.

## Estimates and actual use

Before a member holds a request, the page shows an estimate labelled with its model and rate version. These are invented test values in `src/ai-budget-policy.ts`: `simulated-model-v1` and `simulated-rates-v1`, priced in simulated points rather than money.

| Case                                         | What happens                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Request queued                               | The estimate is stored with the hold in the same transaction.                                                                               |
| Provider reports usable usage                | The unit is consumed once. One settlement holds actual tokens and points, and commits with the consumption.                                 |
| Actual cost is over the estimate             | The member still pays one unit. The page says it went over. The full actual cost counts against the test spending ceiling (below).          |
| Usage is missing or malformed                | The outcome is treated as unknown. The unit stays held, with no refund and no second call.                                                  |
| Settlement fails after the provider answered | Result and consumption roll back. The attempt stays held after its lease and is not called again.                                           |
| No estimate or a retired rate version        | The provider is not called. Withdrawing permission releases the never-started hold. Requests queued before migration 100 are in this group. |
| Simulations are paused                       | No estimate is created and no provider is called.                                                                                           |

Stored figures are integers and version names only. Provider usage is read as two bounded integers, so no other provider text can reach these records. They are immutable, appear in the member's export as `aiUsage`, and are removed only by member erasure.

## Test spending ceiling

Migration 116 adds one platform-wide test spending ceiling, in simulated points of `simulated-rates-v1`. Its invented starting value is 100000 points, room for several hundred demo requests. It is not money and not a real provider ceiling.

| Case                                                  | What happens                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A member queues a request whose estimate does not fit | Nothing is held and no request is created.                                                                                                         |
| A member runs a request whose estimate does not fit   | The provider is not called. The request stays pending with its unit reserved; it can run once there is room, or withdrawing permission returns it. |
| A request is claimed for dispatch                     | Its estimate is committed in the same transaction as the claim, before any provider call. The ceiling row is locked last, so racing claims queue.  |
| The provider's usage settles                          | The commitment moves from the estimate to the actual cost, in the settlement transaction. An overrun counts in full and can close the ceiling.     |
| The outcome is unknown (error, missing usage, lease)  | The estimate stays committed. It is never returned automatically.                                                                                  |
| A known failure before the provider call              | The estimate is returned once: wrong adapter, missing source bytes, ended permission or a pause after the claim.                                   |
| A member is erased                                    | Their per-attempt records go, but the platform total keeps what was committed. It holds no member reference.                                       |

Each attempt has one commitment record, keyed by request and attempt number. A database trigger keeps the platform total in step with these records, refuses a commitment that would pass the ceiling, and allows each commitment to close only once, as settled or restored. Platform administrators see the ceiling, committed and remaining points on the simulation control page. The page names no member, request or source. Unmetered simulations carry no estimate and are not counted.

### Changing the test ceiling

Migration 117 lets a platform administrator raise or lower the test ceiling on the simulation control page (`/operator/local-ai`). It is still invented test points, not money.

| What happens                                     | Result                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| An administrator raises a full ceiling           | New metered requests whose estimate fits can be queued and run again.                                                                        |
| An administrator lowers it, even below committed | New requests that do not fit are refused before any provider call. Nothing already committed is refunded, cancelled or retried. 0 stops all. |
| The ceiling changed after the page was opened    | Nothing changes. The administrator is asked to reload and check the current value.                                                           |
| The same form is sent twice                      | One change. The same form key with a different value is refused.                                                                             |
| Anyone else, or an invalid or unchanged value    | Refused, and nothing is recorded. Values are whole numbers from 0 to 1000000000000.                                                          |
| A change runs alongside dispatch claims          | They queue on the ceiling row; each claim is checked against the ceiling in force when it is made.                                           |

Every change writes one record, in the same transaction, with the ceiling it replaced, the new ceiling, committed points at that moment, the rate version, the time and the administrator. A database trigger refuses a record from anyone but a current platform administrator, or one that does not match the ceiling and committed points in force, and refuses any later edit or deletion. Removing the administrator's account clears only that link. The control page lists the 10 most recent changes without naming members, requests or administrators. The trigger does not stop a direct database update of the ceiling row itself; test setup relies on that, and such an update leaves no record.

## Unfinished requests per member

A member can have at most 3 unfinished AI requests at a time, across all their samples (#190). Unfinished means waiting, running, failed and waiting for another try, or held because the outcome is unknown. Unmetered simulations and metered test requests share the limit.

| What happens                                               | Result                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A member with 3 unfinished requests asks again             | Refused before any test unit is held, any estimate is stored, the spending ceiling is checked or a provider is called. |
| One finishes, or permission is withdrawn before it started | Its place is free and the next request can be queued.                                                                  |
| One is held with an unknown outcome                        | It keeps its place until it is checked. It is never retried to make room.                                              |
| Several are queued at once                                 | A per-member lock serializes them, so the limit is never passed.                                                       |
| An already queued request is sent again                    | Still answered as queued, even at the limit.                                                                           |

The limit is a fixed invented value for the test path, not a plan allowance. Other members' requests never count.

This does not set a real rate, currency, spending ceiling or grant. Those remain inputs for a real provider under #188. Resolving held requests is #189.

## Transactions and migration

Migration 053 adds an immutable owned job/reservation link and policy, validates category/quantity/local job identity, and enforces job/reservation outcome agreement. Legacy jobs acquire no link, inferred allowance or charge. Reapplying migrations preserves populated legacy and metered history. The composite job/member index adds storage; index creation and foreign-key replacement/validation take PostgreSQL table locks and can wait behind active writers. Apply with affected workers stopped and allow for the retained job/reservation table sizes; no production performance or online migration is claimed.

Queue insertion, reservation and its immutable event share one caller-owned transaction. The durable dispatch claim commits before computation; final result, consumption and its event share another transaction. Shared connection-bound ledger operations neither open a second pool connection nor commit independently. Generic settlement cannot spend or release linked local-job reservations. Receipt/revision/deletion cancellation uses the same database release accounting as the ordinary ledger. Final session, grant and dispatch-lease deadlines withhold late or uncertain results; pool/COMMIT faults disclose no private error or optimistic success.

## Non-destructive rollback

Use the existing platform-admin local pause control to disable both queue and dispatch. Stop active local workers before changing application versions. Keep migration 053, its constraints, linkage and ledger restrictions in place; retain pending, consumed and uncertain history. Do not downgrade to a worker that does not understand metered links, drop populated tables, reset claims, refund held dispatched units, or delete events. Resume the compatible application only after reviewing the issue's verification evidence; resuming does not redispatch an uncertain claim.

The delivery scope is [#437](https://github.com/deepnative/deep-native-engine/issues/437), under open parent #188. Local fixtures and deterministic simulation evidence do not establish live provider consent, financial approval, qualified review or full-MVP acceptance.
