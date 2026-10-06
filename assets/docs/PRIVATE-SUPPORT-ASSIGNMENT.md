# Private local support assignment

[#477](https://github.com/deepnative/deep-native-engine/issues/477) adds exact support-request administration to the local browser. An existing operator supplies their own noncredential reference; a member supplies their request receipt ID. A current platform administrator can check those exact references, explicitly assign a finite window, inspect metadata history and revoke one grant. There is no request, member or staff directory.

## Enable and use

Use an isolated local preview with invented information and existing finite trusted administrator/operator identities from [protected local setup](PRIVATE-SAMPLE-SUPPORT.md). Set both `DNE_LOCAL_STAFF_ENTRY=enabled` and `DNE_LOCAL_SUPPORT_ASSIGNMENT=enabled`, then restart the preview. Both default to `disabled`; invalid values fail startup. Live mode independently withholds these surfaces. The HTTP server does not provision identities or read their private credential files.

1. The member opens their ordinary private sample support receipt and supplies its **Request receipt** UUID. This does not share the subject, request text, replies, internal notes or files.
2. The operator uses `/staff/sign-in`, then **My local assignment ID**. The page displays only their own UUID and current finite credential expiry. The UUID is a reference, not a credential or permission. Keep the actual credential out of URLs, commands, logs and captures.
3. The administrator signs in through the actual staff form and opens **Support request assignments** (`/operator/support-assignment`). Enter the exact request receipt and operator reference, then check them. Missing, withdrawn, deleting, inactive or wrong-role targets cannot be assigned. An administrator cannot assign themself or substitute another role/purpose.
4. Confirm an explicit start and expiry in canonical UTC, for example the format `2026-10-06T12:00:00.000Z`. The window must be finite, ordered and expire no later than the operator credential. Overlong expiry is rejected, never silently shortened. Recheck references to confirm a new window. Checking alone creates nothing.
5. After explicit confirmation, retain the exact grant receipt. The operator can discover and open the request from **Your granted support requests** when the window is current. A future start gives no early access. Every destination retains its existing current-role and exact-purpose checks.
6. Enter the exact request reference to inspect content-free history. Each page contains at most 20 grants with observed `scheduled`, `current`, `expired`, `revoked` or `ineffective` state. History is a live bounded view, not a frozen export. Follow its signed continuation; restart from the exact request if it expires or application secrets change.
7. Confirm **Revoke this grant** for the intended grant. A repeated revoke is harmless. Fresh operator access denies when no other current exact grant remains. Other overlapping grants stay effective. Revoking support-request access never resolves the request, removes text, refunds units or changes separately granted support effort.

The member's learner cookie and saved progress remain separate from staff entry. These new administration/reference surfaces require explicit staff selection even when an older legacy administrator cookie is valid elsewhere. Current roles and expiry come from PostgreSQL on every operation. Signout remains cookie-local as described in [staff entry](PRIVATE-LOCAL-STAFF-ENTRY.md).

## Uncertain completion and history

An unavailable write may already have committed. The page retains the original exact request, submission key and confirmed window, provides saved-state inspection, and leaves any manual retry confirmation unchecked. Inspect the exact request with **your original submission key** first. No automatic retry, new key or compensating revoke occurs. An identical saved payload returns the same grant without another event; changed payload or a revoked key conflicts. Current administrator authority is always required.

History, exact-key recovery and revoke remain usable for historical expired, revoked or role-changed targets while the request/workspace still exists safely. Their old expiry does not become current administrator authority. Historical metadata cannot restore operator access. Deleting workspaces and erased requests deny; no content or identity directory is exposed to recover them. All new pages are no-store, strictly parse bounded scalar input and use the selected staff CSRF and configured Origin/Host checks.

The implementation uses one bounded existing transaction runner and connection-bound grant/event persistence. It locks the complete sorted principal set, profiles, grants, workspace and exact request in order; creation serializes the administrator's idempotency key. Current-authority deadlines remain conservative through actual COMMIT, native client return and synchronous response acceptance. A late write is unavailable/possibly committed, not a claim that nothing changed. Read-only inspection creates no grant, service or accounting event.

## Roll back and limits

Set `DNE_LOCAL_SUPPORT_ASSIGNMENT=disabled` and restart. The new administration and operator-reference surfaces disappear. Existing grants, history, ordinary member/operator access, export, withdrawal and deletion remain intact; the protected CLI can still revoke exact grants under current administrator authority. Disabling staff entry also makes the new surfaces unavailable. No new schema or migration is required, and rollback must not drop grants or erase immutable history.

Browser assignment is only for `support-request-local-v1` and current operators. The older protected grant API/CLI retains its existing compatibility, including separately authorized administrator targets; its history is accurately labelled. Other reviewer, hold, circle and effort grants remain separate. This adds no units, paid access, staffing promise, SLA, qualified review, remote identity provider or deployment. Parent [#39](https://github.com/deepnative/deep-native-engine/issues/39) remains open.

See [acceptance evidence](PRIVATE-SUPPORT-ASSIGNMENT-EVIDENCE.md) for exact executable mappings and retained failures. The live issue records verified revisions, CI and the dedicated demonstrated-main journey; planned steps and test descriptions alone are not a demonstration.
