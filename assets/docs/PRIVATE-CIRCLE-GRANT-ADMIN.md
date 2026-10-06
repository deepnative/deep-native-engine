# Private local circle grant administration

[#483](https://github.com/deepnative/deep-native-engine/issues/483) adds browser management of existing finite circle moderation grants. It reuses the private report/hide/restore journey from [local circle discussion](LOCAL-CIRCLE-DISCUSSION.md) and the existing staff sign-in. This scope does not approve real community policy, qualified moderation, an escalation or appeal process, commercial access, or deployment. Parent #196 and its policy dependencies remain open.

## Exact local journey

Use invented information in a dedicated local preview. Enable `DNE_LOCAL_STAFF_ENTRY=enabled`, `DNE_CIRCLE_DISCUSSION=enabled`, and `DNE_LOCAL_CIRCLE_ADMIN=enabled`, then restart. Each flag defaults off; invalid values fail startup. Existing finite staff identities are provisioned through protected local setup, never through these HTTP pages. Actual credentials stay out of URLs, captures, source, and logs.

1. A current selected moderator or platform administrator opens **My moderation reference** at `/moderate/circle-reference`. It shows only their server-derived UUID, current role, and finite credential expiry. The UUID is not a sign-in credential or an authorization grant. There is no staff or participant directory.
2. A current selected administrator opens **Circle moderation grants** at `/operator/circle-grants`, enters a known staff UUID and exact private circle, and checks them. A separate explicit self-target form resolves the administrator's own UUID on the server. Checking alone grants nothing.
3. The unchecked confirmation preserves the exact target, circle, fixed `circle-discussion-test-v1` purpose and original UUID submission key. Enter a canonical finite UTC expiry including milliseconds, for example the format `2026-10-06T18:00:00.000Z`. It must still be in the future and no later than the target credential expiry at submission. Overlong windows are rejected, never shortened. Access starts at database creation time; no custom start, backdating, or scheduling UI is provided.
4. Explicitly confirm creation. One grant and its compatible content-free creation audit commit together. Retain the receipt and original instruction. A platform administrator still needs an exact grant to open private circle content; administrator role alone does not bypass that boundary.
5. The granted staff member opens the existing exact circle report queue and can hide or restore an invented reported post under the existing moderation rules. Other circles, proposal/support/reviewer permissions, member-private exercises and paid benefits are unchanged.
6. Inspect a known grant ID or the current creator's original key using a protected POST. History takes an exact target and circle and shows at most 20 records with one lookahead. Continue using the signed POST cursor; invalid, expired, changed-target, changed-circle, changed-actor or changed-secret cursors are rejected rather than silently restarted.
7. Explicitly confirm revocation of one exact grant. Repeated revocation adds no event. Another current overlapping grant continues to permit moderation; fresh access denies after the last applicable grant is revoked. Revocation does not delete posts, rewrite published moderation, change learner progress or revoke a different grant.

## Keys and uncertain completion

The existing idempotency UUID remains globally unique. Identical currently authorized creator/key/target/circle/expiry submissions return the original immutable grant without another creation audit. Changed payload or another creator conflicts without returning the foreign grant. Different keys deliberately permit overlapping grants. Creation replay remains a current mutation: pause, an expired requested window or an ineligible target can prevent it. Historical inspection is a separate read operation and does not inherit those mutation restrictions.

A failed or late COMMIT acknowledgement may follow a durable write. The browser reports uncertainty, keeps the original readonly target, circle, key and expiry, and leaves confirmation unchecked. Explicit saved-state inspection may open a protected result in a new tab with no opener. A manual retry preserves the same instruction. There is no automatic retry, replacement key, compensating revoke, key in a URL, or credential in the result.

A missing key is an unknown result on that observation, not proof of noncommit. Erasure can remove the retained grant and key; audit cannot reconstruct the erased key or full receipt. Inspection never creates or restores authority.

## Transaction and lifetime boundaries

One connection owns authorization, mutation and audit. The order is existing circle advisory lock (7529), sorted principals, sorted profiles, then exact grant rows. The selected actor's current credential hash is rechecked on the locked principal, with current role and finite validity. Creation also locks and validates the current eligible target. Cross-circle contention uses the existing global key constraint with `ON CONFLICT DO NOTHING`, followed by a current READ COMMITTED winner comparison on the same transaction. Deterministic key conflict does not continue an aborted transaction or become generic uncertainty.

The dedicated administration transaction bounds connection acquisition to three seconds, each query to at most five seconds, and the request to ten seconds. Database observations charge the complete handback interval against monotonic time and retain the earliest deadline. No later observation extends it. Check/create additionally include current target validity; create includes the finite requested grant window through COMMIT. Acceptance checks run after COMMIT, client release/native return, and immediately before and after synchronous HTTP rendering. A late write remains possibly committed and unavailable. No rollback or retry is queued behind an unacknowledged COMMIT.

Historical inspection, history and exact revoke require the current administrator, but do not require an old target or grant window to remain current. They never use a historical date to extend administrator authority or to block structural inspection artificially. Fresh moderation still checks the current selected credential, matching staff role, exact circle and purpose, and effective grant.

## What erasure preserves

| Event                                                     | Retained structural result                                                                                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target credential expires, is revoked, or changes role    | The grant remains inspectable and individually revocable; its effective state is observed afresh. It does not provide fresh content access.                                                                      |
| Target staff principal is deleted                         | Existing FK cascade removes the grant and key. Immutable grant audit retains only event/actor/target/grant/circle IDs, action and timestamp.                                                                     |
| Creator principal is deleted but target is another person | The existing grant survives because creator ID has no principal FK. The erased creator credential cannot inspect or mutate it. A current administrator may inspect its exact structural record.                  |
| Creator is also the deleted target                        | The target cascade removes that self-target grant.                                                                                                                                                               |
| Member/workspace is erased or a post is withdrawn         | Existing member-owned discussion/export/withdrawal behavior remains responsible for those records. A circle staff grant is not a member-owned receipt and does not preserve or resurrect private member content. |

Source-absent history groups surviving events into one labelled stub per grant ID. It does not fabricate role, purpose, key, start, expiry or creation payload. Cursor ordering remains by grant UUID through retained and source-absent records. History is a bounded live view, not a frozen export. This adds no retention table, tombstone reservation, production retention policy or legal conclusion.

## Pause and rollback

Set `DNE_LOCAL_CIRCLE_ADMIN=disabled` and restart to stop new browser grants. Disabling discussion likewise pauses new grant creation and member discussion writes according to the existing flow. Current administrators can still inspect retained state/history and revoke exact grants while creation is paused. Flags neither reprovision credentials nor restore revoked authority. Disabling local staff entry or using live mode withholds these new surfaces. Existing protected CLI semantics remain intact.

The implementation uses existing migration055 grants and immutable audit. Migration061 adds only `(staff_id, circle_id, grant_id, id)` to support bounded source-absent audit history; the retained-grant scope index already exists. Index-only removal/reapplication preserves populated055 payloads and history. Rolling back UI wiring must not delete populated grants or audit. Existing member export remains own discussion data, never a global grant/audit directory.

Executable evidence and the dedicated demonstrated-main revision are recorded on the live issue and in the accompanying delivery evidence. Described behavior alone is not a passing gate, deployment, demo or completion of the broader parents.
