# Private member sample holds

Issue [#385](https://github.com/deepnative/deep-native-engine/issues/385), under the still-open [CTP-012 #29](https://github.com/deepnative/deep-native-engine/issues/29), connects the explicit sample windows from #294 to the synthetic atomic reservation from #296. This is a private loopback preview. It provides no real booking, qualified capacity, paid access, provider notification, calendar/email delivery, cancellation policy or service fulfillment.

## Member behavior and test-only deadline

`/availability` shows currently eligible explicit sample windows with exact UTC and the member's configured local time. A form appears only when that member has an explicitly seeded, matching current `coach_minutes` or `review_minutes` grant with at least 60 available units. Background, profile, cohort and foundation membership never create a grant. The transaction validates the grant again; a visible form is not proof that capacity or minutes remain available.

The server reserves 60 test minutes and sets the deadline to the earlier of **10 minutes after the request** or **one second before the slot starts**. A deadline already reached fails closed. This is solely a short synthetic hold, not a commercial cancellation or no-show term. The receipt says **SAMPLE HOLD — NOT A BOOKING** and retains its exact sample service, domain, slot, UTC times, quantity, state and deadline. If the member later removes their time zone, the receipt explicitly labels its UTC fallback rather than presenting it as local time.

Each slot form carries its own random request UUID, stable for resubmissions of that form. Identity comes only from the active member token. The request accepts only CSRF, slot ID, grant ID and request UUID; it rejects posted member IDs, categories, quantities and deadlines. The same owner/request replays the same receipt even after expiry; it never extends the deadline or creates a second reservation. A changed slot or grant on that request conflicts. Receipt URLs use that same request UUID, so they remain discoverable even if the original response is lost. The availability page also lists the owner's receipts. A different member or staff session cannot read them through the member route.

Known validation/eligibility rejections report that this request created no new hold. An unknown database/write outcome reports neither success nor failure: the member must inspect that request's receipt and their current receipts before trying a new request. A temporarily unavailable or missing receipt is not itself proof that an earlier write failed.

## Transactions, expiry and private data

Migration 045 adds `synthetic_member_hold_receipts` and the member wrapper. Its key is namespaced by owner and request. The existing `synthetic_hold_slot` transaction takes the request advisory lock, slot/registry/staff locks, then grant/member locks; the wrapper does not acquire a member row lock ahead of the slot. It checks the active token before work and rechecks member, grant, staff and deadline wall-clock expiry after lock waits. Receipt creation, hold, reservation, reserve event and debit commit or roll back together. The receipt snapshots service/time fields under the hold locks.

Expired holds are settled lazily, without a background service. Reloading an owner's receipts settles only that owner's due receipt, one transaction per receipt. The availability read does not settle another owner's hold; it hides only holds whose deadlines are still in the future. A request for a slot with a due incumbent first settles that incumbent in a separate authenticated committed operation, then competes through the existing atomic slot-plus-ledger transaction. This prevents a transaction from retaining one member's expiry locks while acquiring another member's reservation locks. A failed new request may leave an already-due incumbent settled, but cannot leave a new hold or debit. Not-yet-due holds are never released by lazy expiry; only the explicit owner withdrawal described below can release them early. A stable expiry key serializes receipt reloads and competing claimants through the already delivered `synthetic_expire_slot_hold` function. The wrapper takes its expiry-key, slot, reservation, grant and member locks before supplying a fresh wall clock to settlement, so grant/member expiry during a wait cannot revive expired units. The internal API retains its explicit deterministic fixture clock. The existing conservation rule returns minutes only while the original grant and member access remain current; otherwise reserved minutes become expired units. It cannot mint replacement credit or consume a held service.

Retained private data consists of member/request/hold/slot/grant identifiers and a snapshot of the domain, service and exact time window. Hold/ledger tables retain the existing quantity, state, deadline and event evidence. Member pages expose neither qualification/agreement/conflict references nor other members' ledger state. Member deletion cascades through the receipt, hold and synthetic ledger records. No new external integration, credential, free-text field or entitlement policy is added.

Rollback of the feature means removing the member routes/runtime binding while preserving retained receipts and ledger records. Do not delete active holds or decrement reserved minutes manually: use the existing expiry transaction after their deadline. There is no production deployment or migration rollback authorization in this slice.

## Explicit sample-hold withdrawal (partial #29)

## Receipt reads while account deletion is pending (partial #42)

An account-deletion request may commit its workspace `deleting_at` marker before cleanup removes its principal, grants and sample-hold receipts. Receipt and availability reads now require the current member principal and an owned, nondeleting workspace in one read transaction. The read locks the principal before the workspace, matching deletion's lock order, and checks session expiry with the database wall clock after any lock wait. A committed deletion receives a generic missing-receipt page for the exact receipt URL and a content-free denial on `/availability`; neither reveals the retained service, domain, time, receipt ID or grant. Another active member's sample availability remains available.

Lazy settlement remains a separate, one-receipt transaction before the final private read, preserving the existing slot-to-member lock order and ledger behavior. A read error or uncertain commit withholds the private result; an uncertain read transaction is not replayed. No receipt or grant is deleted by the read guard, and the normal deletion cleanup still owns removal. To roll back this runtime change, revert the guarded read and route handling together after reviewing the privacy impact; retain the data, migration and existing settlement rules. This is a private local synthetic boundary, not a live booking or accepted full-MVP security assessment.

The owner of an active sample receipt can explicitly choose **Withdraw sample hold**. The action is a CSRF-protected POST to `/availability/holds/:requestId/withdraw`; it accepts only CSRF, derives identity from the current member token, and rejects posted member, category, grant, deadline or replacement request fields. Receipt IDs are scoped to their owner; the internal hold ID is not a member receipt capability. Another member, staff, anonymous, revoked, expired or deleted session cannot withdraw an owner's hold or read its receipt.

Migration 046 adds the terminal `released` hold state and `released_at`. The original receipt, service/category meaning, slot, exact UTC window, quantity and test-only deadline remain intact. The form is absent on released or expired receipts. Replaying the original withdrawal returns that same receipt, including after another member or a later request acquires the slot; it does not release the later hold or create another balance increase. Replaying the original hold request likewise returns its terminal receipt rather than extending it.

Withdrawal uses the same per-hold advisory lock as lazy expiry, followed by the slot and existing hold/reservation/grant/member row locks. It rechecks token, member access, grant linkage/category and the wall clock after all waits. If the deadline has arrived, expiry wins and the returned receipt says `expired`. Otherwise one transaction releases the linked reservation, changes the hold to `released`, and appends one immutable `sample-withdraw:` ledger release event. A current grant regains its 60 test minutes; an already expired grant receives expired units, never spendable credit. An event-write failure rolls back the slot, reservation, balance and hold state together. No new allowance is created.

Unknown database or transport outcomes report neither success nor failure. The recovery page links back to the stable private receipt; the owner inspects it before retrying. A response lost after commit is recoverable as the same released receipt, without another event. Known rejection likewise directs the owner to inspect current state rather than assert that no prior request succeeded.

This is sample-capacity withdrawal only. It defines no actual appointment cancellation, 24-hour term, no-show policy, provider-caused credit, qualified service, payment or external notification. Parent #29 remains open for those unmet areas and the #13/#95/#96 decisions. Rollback means disabling the member withdrawal route while retaining migration 046, terminal receipts and immutable release history; do not delete or manually reverse released records.

On unchanged main `129e9536a98a613b1334f366c7bddd47b9fc52bb`, rendering an active owner receipt failed the explicit `Withdraw sample hold` assertion before these edits. The baseline gate's browser phase was deliberately stopped after passing repository, unit and real-PostgreSQL integration checks; that interrupted run is not a full baseline pass. New critical approved case L94 in `initial-learning-v65` adds desktop/mobile keyboard withdrawal, denial, failed-write recovery, reload, replay and rebooking while retaining all 93 previous local cases and the separate full-MVP denominator. PostgreSQL cases cover successful active-withdrawal/last-slot races, duplicate withdrawal, deadline-expiry races, session/grant/deadline changes during lock waits, immutable evidence, atomic rollback, deleted owners and response loss after commit. Final command results belong to the delivery evidence; these local cases make no deployment or commercial acceptance claim.

## Explicit local test seeding

The application never seeds an allowance. For a disposable local preview, first create a member in the browser and obtain that member's UUID from its own structured export. An operator/test author must explicitly select that UUID and use the existing internal `syntheticLedger(pool).grant` method. Do not select an arbitrary or most-recent member. No HTTP grant endpoint is introduced.

For example, save this as a temporary local script at the repository root (keep it untracked), replace the UUID with the intended synthetic member, and run it with Node 24 and the local `.env`. It creates one current one-hour **sample** coaching slot and exactly one 60-minute test grant. All staff and references are invented fixtures, not qualification evidence. Run only against the disposable loopback preview database; each execution intentionally creates a new independent fixture.

```typescript
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { authorizationStore } from './src/authorization.ts';
import { availabilityStore } from './src/availability.ts';
import { syntheticLedger } from './src/ledger.ts';

const memberId = 'REPLACE-WITH-EXPLICIT-SYNTHETIC-MEMBER-UUID';
const url = new URL(process.env.DNE_DATABASE_URL!);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/dne_dev')
  throw new Error('Use only the disposable local preview database.');
const pool = new Pool({ connectionString: url.toString() });
try {
  const auth = authorizationStore(pool);
  const token = () => randomBytes(32).toString('hex');
  const end = new Date(Date.now() + 7 * 86400000);
  const admin = await auth.provisionStaff(token(), 'platform_admin', end);
  const operatorToken = token();
  await auth.provisionStaff(operatorToken, 'operator', end);
  const primary = await auth.provisionStaff(token(), 'coach', end);
  const backup = await auth.provisionStaff(token(), 'coach', end);
  const registry = randomUUID();
  await pool.query(`INSERT INTO expert_registry
    (id,staff_id,staff_role,domain,service_type,starts_at,ends_at,
     loaded_cost_cents,capacity_minutes,backup_staff_id,qualification_ref,
     agreement_ref,conflict_review_ref,verified_by,verified_at)
    VALUES ($1,$2,'coach','education','coaching',CURRENT_TIMESTAMP,$3,
      12000,60,$4,'invented fixture','invented fixture','invented fixture',$5,CURRENT_TIMESTAMP),
      ($6,$4,'coach','education','coaching',CURRENT_TIMESTAMP,$3,
      12000,60,$2,'invented fixture','invented fixture','invented fixture',$5,CURRENT_TIMESTAMP)`,
    [registry, primary, end, backup, admin, randomUUID()]);
  const startsAt = new Date(Date.now() + 86400000);
  const slotId = await availabilityStore(pool).create(operatorToken, registry,
    startsAt, new Date(startsAt.getTime() + 3600000));
  if (!slotId) throw new Error('Sample fixture was not eligible.');
  await syntheticLedger(pool).grant(memberId, 'coach_minutes', 60,
    `manual-sample-${randomUUID()}`, {
      startsAt: new Date().toISOString(), expiresAt: end.toISOString()
    });
} finally { await pool.end(); }
```

For a file named `seed-sample-hold.ts`, run `node --env-file=.env seed-sample-hold.ts` with Node 24. Remove the temporary script after the explicit fixture action.

Then reload `/availability` in that member's browser. It must still describe a test allowance and sample hold. Do not treat this fixture as a live offer or use it to decide foundation pricing, coaching grants or commercial cancellation terms. Those decisions and qualified capacity remain under #13/#95/#96 and parent #29.

## Evidence boundary

On unchanged main `884adeb8e681eebd9ea4c87924caa8e76eb5a3cf`, the existing availability view rendered the sample window but failed an assertion for `Reserve sample hold`; the added behavioral unit test reproduced that failure before implementation. The unchanged-main full `make verify` passed with Node 24.21.0 and Python 3.12. The new approved critical browser case is L93 in `initial-learning-v64`; it extends the prior 92 cases and preserves the separate full-MVP inventory. The browser uncertainty case injects a precommit database fault; a separate real-PostgreSQL boundary test simulates a lost response after the write has committed and recovers the same receipt without another debit. Review probes first reproduced stale-time expiry conservation and an opposite-owner lock cycle, then passed after the fresh post-lock clock and separate cleanup transaction changes. Unit, real PostgreSQL, browser and complete dirty-gate results are recorded in the delivery handoff and generated reports; none establish exact-commit CI, merge, deployment or full-MVP acceptance.

## Private read lifetime

[The bounded-read guide](CTP-023-SAMPLE-HOLD-READ-LIFETIME.md) documents current session expiry through preparation, lock waits, commit replies and resource handback. Private results are withheld on expired or uncertain reads; fresh authorized receipt inspection remains distinct from retrying an unknown write. Lazy settlement already committed before a later read fails is not reversed. This adds no booking, paid-access or qualification policy.
