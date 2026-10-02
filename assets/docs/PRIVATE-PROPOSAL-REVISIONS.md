# Private proposal changes and resubmission

This local preview lets a learner correct a private invented contribution after a current moderator requests changes. It is not publication, qualified review or a rights licence. IT, other professions and general learning backgrounds use the same owner permissions.

## The learner and moderator cycle

The learner saves a private draft and confirms rights for the exact revision before submitting. A current moderator or platform administrator can return a submitted revision with explicit learner-visible feedback. The feedback identifies the reviewed revision and request time. The learner edits the same proposal, then freshly confirms rights before resubmitting the newer revision. The moderator queue shows the current submitted text.

A request clears both the previous rights timestamp and exact rights revision. An unchanged returned proposal cannot be resubmitted. Repeating an identical current decision acknowledges its result without another audit event; changed or stale forms conflict. Recovery from an uncertain write is read-only inspection, never automatic replay.

## Privacy and retention

Only the current owning member can read retained feedback. Staff queue projections and unrelated members receive no feedback or staff identifiers. One current feedback text is retained through correction and resubmission, pinned to its source revision. A later request replaces that text; no previous feedback or proposal-text versions are retained. The immutable audit contains action, actor/role, proposal/workspace, state, reviewed revision and time, with no text or text hash.

Owner structured export includes the retained current feedback and rights metadata under local-member-records-v15. Cursor v2, stable section indexes, the 100-record and 256-KiB limits remain unchanged. Withdrawal and rejection redact proposal text, feedback and workflow links together. Account deletion cascades proposal feedback and owning-workspace audit. Quarantine freezes edits and resubmission; retained feedback remains a prior-cycle owner reference, not approval.

## Versions and authorization

Workflow ID/version remains immutable. Editing and resubmitting require that source version to be current; a stale or retired version remains readable and withdrawable, and needs a new proposal for a new source version. Legacy submitted or quarantined proposals may have an unknown exact rights revision. The migration does not infer consent from old timestamps.

Transactions lock current principals, the staff profile where required, the non-deleting owner workspace, proposal and audit in a consistent order. Final database-clock expiry is checked after waits and writes. Lock and statement waits remain bounded. Query, COMMIT or rollback uncertainty returns no private result; failed rollback or uncertain COMMIT discards its connection. This is a private local concurrency boundary, not hosted release acceptance.

## Operation and rollback

The additive migration adds current feedback/reviewed-revision/request-time and exact rights-revision fields, plus a nullable reviewed revision on the content-free audit. It deliberately replaces relevant state and consent checks while leaving historical consent unknown.

An older binary cannot safely interpret changes_requested or revised rights. Disable affected proposal edit, submit and moderation routes before any binary rollback. Preserve rows until a compatible migration/binary path is available; do not erase returned proposals or fabricate rights confirmation to satisfy old code. No public publication or provider action is enabled by this feature.

## Evidence boundary

Issue #431 records lifecycle, replay, authorization, redaction, export and concurrency evidence. Complete delivery requires the exact-commit gate, unbypassed pre-push, self-review, current PR CI, guarded merge, resulting-main CI and branch cleanup. Parent #40 remains open for its broader participation/publication and qualified decisions.
