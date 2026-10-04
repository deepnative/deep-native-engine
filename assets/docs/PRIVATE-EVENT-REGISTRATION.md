# Private local event registration

Issue #456 adds an invented-data enrollment rehearsal under parents #119 and #37. It does not provide a real appointment, qualified expert, notification, payment, recording or live clinic. Delivery verification and the verified-main demo are still pending.

## Run and use

Use the normal local PostgreSQL application setup. Set `DNE_EVENT_REGISTRATION=enabled` in the local environment and restart the application. The default is `disabled`; the registration store refuses live mode even if the flag is enabled. Each Git-versioned event must also explicitly set `localRegistration: true`. The catalog includes a one-seat `local-registration-rehearsal` fixture, available to all three learner directions.

From Sample events, open Local event registration rehearsal and choose Try local registration rehearsal. Inspect its exact version, UTC and saved-zone schedule, and observed capacity. Explicitly acknowledge invented data before enrolling. The owned receipt survives reload. Another member sees a full rehearsal, without attendee identity or receipt IDs. Withdraw the exact registration to release the seat. A later enrollment has a new identity; replaying the old withdrawal cannot remove it.

Registration history is private and paginated, twenty records per page. Records are ordered by immutable registration ID, not by booking time. The private records download appends event enrollments after existing sections without renumbering their cursors. Account/workspace deletion removes owned registrations and releases their seats. Expiring a session does not itself release a durable seat.

## Failure recovery and versioning

After an uncertain response, inspect the saved history or original attempt link before submitting again. There is no automatic retry. A successful database commit can remain durable even when its late response is withheld because authority expired. Use a fresh valid session to inspect the actual state; never infer failure means a free seat.

A registration pins event ID, version, title, schedule and capacity. Same-version catalog changes conflicting with persisted inventory refuse new enrollment. Publish a distinct version for a changed schedule; old receipts remain readable and withdrawable, and no enrollment transfers automatically. The current catalog is process-local: this rehearsal assumes one current deployment version. It is not a cross-deployment cancellation or live event scheduling protocol.

## Pause and rollback

Set `DNE_EVENT_REGISTRATION=disabled` and restart to stop new enrollment. Preserve receipt/history/export/withdrawal/deletion routes and migrations. Existing registrations retain their seats until withdrawal or erasure; pausing does not cancel them. Keep additive migration057 and its ownership, capacity and immutability constraints. Do not drop enrollment tables or roll back to a binary that cannot expose withdrawal and erasure. A compatible rollback preserves these readers and lifecycle actions while disabling enrollment.

## Acceptance boundary

Real clinic staffing, cancellation/attendance, qualified coverage, funded access, provider integration and recording remain separate parent work. Local tests and demos do not establish those outcomes. Exact-revision full verification, mandatory pre-push, PR/main CI, cleanup and the isolated milestone demo must complete before marking #456 Done.
