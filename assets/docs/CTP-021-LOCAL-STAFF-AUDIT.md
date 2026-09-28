# Local staff authorization audit

Issue [#327](https://github.com/deepnative/deep-native-engine/issues/327) implements the local synthetic staff grant/read portion of [CTP-021 #40](https://github.com/deepnative/deep-native-engine/issues/40).

Successful platform-admin assignment, support and exact-evidence-review grant creation and revocation append one event in the same PostgreSQL statement as the change. Denied and repeated revocations append none. Each newly created grant has its own identity; the grant API has no request-idempotency key. A successful coach or support workspace read appends one event before returning content, even when the workspace contains several records or the staff member has several grants. Grant row locks serialize reads against revocation. A database audit-write error aborts the operation, preserving the prior grant state and withholding private read results.

Events contain only an event ID, actor/staff/workspace/grant UUIDs, controlled grant type/action and database time. They contain no token, token hash, exercise/evidence content, filename, file bytes or copied purpose text. Exact support purpose matching remains part of authorization; the purpose is not copied into the audit. Direct mutation of existing events is rejected while the workspace exists. Grant revocation or deletion leaves history intact. Local member/workspace deletion cascades only that workspace's rows.

## Local operator inspection

A trusted local database operator can inspect a bounded workspace history using a parameterized query. This grants no new application privilege and adds no public/member endpoint:

```sql
SELECT id, actor_id, staff_id, workspace_id, grant_type, grant_id, action, occurred_at
FROM authorization_audit
WHERE workspace_id = $1
ORDER BY id DESC
LIMIT 100;
```

This is a local application invariant, not a tamper-proof log against the database owner. An owner can change schema/triggers or truncate tables. No hosted operator permission or production retention period is established.

## Migration and rollback boundary

Migration `035-staff-authorization-audit.sql` preserves existing support-read event IDs, staff/workspace/grant identities, action `support_content_read` and recorded times. It derives the historical actor from the reading staff identity, classifies the grant as support and drops the copied free-text purpose column. It does not invent historical grant/revoke events. New reads use `workspace_read`; new grant actions use `grant_created` and `grant_revoked`. Repeated migrations preserve the sanitized history.

The migration runs in a transaction. A failed migration rolls back its schema changes. After commit, the removed text cannot be reconstructed from audit rows; rolling application code back alone is incompatible with the new schema. Stop the local preview and apply a reviewed forward repair if needed. Any separately retained old database backup may still contain legacy text; row/column deletion does not prove backup, WAL or physical-media erasure.

Real PostgreSQL tests cover successful and denied changes, concurrent/repeated revocations, both read/revoke lock orderings, audit failure rollback, private-field exclusion, historical migration, immutable history and two-workspace deletion isolation. Browser journey L16 exercises the existing private-workspace HTTP boundary on the approved browser matrix. These remain synthetic local evidence. Hosted retention, backup expiry, jurisdiction and operator policy remain in [#12](https://github.com/deepnative/deep-native-engine/issues/12); broader staff exports, billing logs and community/privacy acceptance remain open in #40.
