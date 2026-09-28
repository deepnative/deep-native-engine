# Local staff authorization audit

Issues [#327](https://github.com/deepnative/deep-native-engine/issues/327) and [#329](https://github.com/deepnative/deep-native-engine/issues/329) implement the local synthetic staff grant/read and evidence-access portions of [CTP-021 #40](https://github.com/deepnative/deep-native-engine/issues/40).

Successful platform-admin assignment, support and exact-evidence-review grant creation and revocation append one event in the same PostgreSQL statement as the change. Denied and repeated revocations append none. Each newly created grant has its own identity; the grant API has no request-idempotency key. A successful coach or support workspace read appends one event before returning content, even when the workspace contains several records or the staff member has several grants. Grant row locks serialize reads against revocation. A database audit-write error aborts the operation, preserving the prior grant state and withholding private read results.

Events contain only an event ID, actor/staff/workspace/grant UUIDs, controlled grant type/action and database time. They contain no token, token hash, exercise/evidence content, filename, file bytes or copied purpose text. Exact support purpose matching remains part of authorization; the purpose is not copied into the audit. Direct mutation of existing events is rejected while the workspace exists. Grant revocation or deletion leaves history intact. Local member/workspace deletion cascades only that workspace's rows.

Staff evidence links append `evidence_link_issued`; successful source-object reads append `evidence_bytes_loaded`. Both identify `evidence_id` and `assignment_grant_id`. Coach events use the assignment as `grant_id` with type `assignment`; reviewer events use the exact evidence grant as `grant_id` with type `evidence_review`. Each operation selects the lowest eligible assignment UUID, then the lowest exact-grant UUID for that assignment. Multiple matching grants never multiply events. Member-owned and authorized circle access create no staff event.

The evidence operation holds a single database transaction, locking the principal, workspace, clean evidence, reviewer submission if needed, selected assignment and exact grant in that order. These locks serialize successful access against session/grant revocation, consent withdrawal, submission withdrawal and evidence/workspace deletion. Source bytes are read before their audit event is inserted; storage failure creates no successful byte-load event. A fresh database wall-clock expiry check and capability check run after potentially slow storage/audit work, before commit. Expiry rolls back the event; failed audit writes or commits withhold the link/bytes. A commit whose acknowledgement is lost may leave an event despite an error response, but no bytes are returned without an acknowledged commit. The event records the committed authorization operation, not proof that a browser received or opened the response.

## Local operator inspection

A trusted local database operator can inspect a bounded workspace history using a parameterized query. This grants no new application privilege and adds no public/member endpoint:

```sql
SELECT id, actor_id, staff_id, workspace_id, grant_type, grant_id,
       evidence_id, assignment_grant_id, action, occurred_at
FROM authorization_audit
WHERE workspace_id = $1
ORDER BY id DESC
LIMIT 100;
```

This is a local application invariant, not a tamper-proof log against the database owner. An owner can change schema/triggers or truncate tables. No hosted operator permission or production retention period is established.

## Migration and rollback boundary

Migration `035-staff-authorization-audit.sql` preserves existing support-read event IDs, staff/workspace/grant identities, action `support_content_read` and recorded times. It derives the historical actor from the reading staff identity, classifies the grant as support and drops the copied free-text purpose column. It does not invent historical grant/revoke events. New reads use `workspace_read`; new grant actions use `grant_created` and `grant_revoked`. Repeated migrations preserve the sanitized history.

The migration runs in a transaction. A failed migration rolls back its schema changes. After commit, the removed text cannot be reconstructed from audit rows; rolling application code back alone is incompatible with the new schema. Stop the local preview and apply a reviewed forward repair if needed. Any separately retained old database backup may still contain legacy text; row/column deletion does not prove backup, WAL or physical-media erasure.

Migration `036-staff-evidence-access-audit.sql` adds nullable historical evidence/assignment UUIDs and expands controlled action constraints. Prior #327 event IDs, actions and times remain unchanged with null new fields; the migration invents no evidence-access history. Evidence/grant UUIDs intentionally have no cascading foreign keys, so evidence or grant removal cannot discard an access event. Workspace deletion remains the sole application deletion boundary for history. Reapplying the migration preserves both old and new events. The transaction rolls back a failed schema upgrade. After successful upgrade, stop the preview and use a reviewed forward repair; do not drop the new columns or restore old application code that resumes unaudited evidence access. No destructive down-migration is provided.

Real PostgreSQL tests cover successful and denied changes, concurrent/repeated revocations, both read/revoke lock orderings, audit and storage failure, private-field exclusion, historical migration, immutable history and two-workspace deletion isolation. Evidence tests also hold object reads until actual principal/assignment/exact-grant expiry and verify that no bytes or audit success escape. Browser journeys L16 and L19 exercise private-workspace and staff-evidence HTTP boundaries on the approved browser matrix. These remain synthetic local evidence. Hosted retention, backup expiry, jurisdiction and operator policy remain in [#12](https://github.com/deepnative/deep-native-engine/issues/12); broader staff exports, billing logs and community/privacy acceptance remain open in #40.
