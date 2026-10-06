# Cancel an invented local event

This private preview lets a current platform administrator cancel one exact, future, opted-in event version. It is not a real clinic appointment, notification, refund, attendance record or qualified service.

## Browser journey

Use the normal local PostgreSQL setup. Enable `DNE_LOCAL_STAFF_ENTRY`, `DNE_EVENT_REGISTRATION` and `DNE_LOCAL_EVENT_ADMIN` only in an invented-data local preview. Event administration defaults to disabled and cannot operate in live mode. Existing trusted staff provisioning is required; learner background or goal never supplies administrator authority.

Sign in through `/staff/sign-in`, open **Event cancellation**, and enter the exact event ID and version. Check the readonly title, UTC schedule and sample capacity. Confirm the initially unchecked choice deliberately. The receipt records one permanent cancellation of that version. A different version stays separate.

Members retain their owned registration ID and history. Receipt, discovery, detail, rehearsal and export show cancellation; new registration closes. Voluntary withdrawal has its own timestamp and remains available. Deleting a member erases owned registrations while keeping the event cancelled.

## Unconfirmed actions

If the result is unavailable, cancellation may have committed. Keep the original readonly key, reference and checked snapshot. Use the protected **Inspect saved cancellation in a new tab** POST before manually repeating. The repeat choice starts unchecked and uses the same instruction. There is no automatic retry, replacement key or compensation. No saved result is not a promise that an earlier pending request cannot complete.

A current administrator may inspect historical cancellation after the event starts or its catalog version retires. Original-key inspection/replay is restricted to its creator and exact payload. Erased creators cannot recover authority from a retained key; keys remain reserved. New keys cannot cancel past, retired, unknown or non-opted-in events.

## Persistence and privacy

Migration062 adds an immutable canonical cancellation, a monotonic exact-version state fence, and globally reserved structural operation records. Inventory retains its original title/schedule/capacity; cancellation does not rewrite registrations as withdrawn. Canonical facts contain only event/version, UUID and cancellation time. Operations contain key, nullable administrator reference, exact event/version, canonical cancellation ID, action and time. They store no attendee list, free-text reason, member work or credentials. Administrator erasure nulls its operation actor; canonical cancellation and reserved key remain. These are functional structural records, not a legal retention promise.

Member export v23 adds `cancelledAt` to the existing event-registration section32. Signed cursor-v2 section indices, UUID order, record/byte limits and owner binding stay stable. Member export does not include staff operation keys or actor references.

## Lock graph and bounded authority

Administrator cancellation takes the selected principal and current staff profile before exact inventory and cancellation-state locks. It never locks attendee workspaces or mass-updates registrations. Enrollment takes its owned member/workspace before that same inventory/state fence. Direct legacy INSERT follows workspace then inventory/state; old repeatable-read/serializable writers encounter the changed state rather than silently enrolling into a cancelled version. Withdrawal/deletion retain their existing owned paths.

Both enrollment/cancellation lock winner orders and rollback are tested with actual PostgreSQL blocking observations. Canonical fact and compatible creator operation commit together. Request, selected authority and event-start deadlines are observed under locks and preserved through COMMIT, release and HTTP rendering. A successful commit whose acknowledgement or timely response is lost yields uncertainty, never fabricated rollback or stale success.

## Pause and compatible rollback

Set `DNE_LOCAL_EVENT_ADMIN=disabled` and restart to stop new cancellation keys. Keep protected inspection and original-key replay, the additive migration, legacy enrollment fence, cancelled member reads/export, withdrawal and erasure. Pausing registration separately stops enrollment; neither toggle uncancels an event. Do not drop tables, clear canonical state, run a destructive down migration or restore a binary that bypasses the cancellation fence. Migration reapplication preserves existing version-pinned active and withdrawn history.

Issue #482 supplies scoped private-preview evidence; parent #119 remains open for actual clinics, staffing, paid access, attendance, group costing and recording.
