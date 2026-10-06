# Exact private sample assignments

Private synthetic local workflow for [#480](https://github.com/deepnative/deep-native-engine/issues/480). The guide describes the bounded interface; current verification and remaining delivery work belong in the [evidence record](PRIVATE-SAMPLE-ASSIGNMENTS-EVIDENCE.md).

This local workflow lets a current platform administrator assign one already consented, clean, queued private text revision to a current reviewer. It reuses the [reviewer worklist](PRIVATE-REVIEWER-WORKLIST.md) and [private sample feedback](PRIVATE-SAMPLE-FEEDBACK.md). It does not approve source safety, appoint qualified reviewers, allocate review minutes or grant general workspace access.

## Use the browser

Enable both `DNE_LOCAL_STAFF_ENTRY=enabled` and `DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION=enabled` in the local preview environment, then restart. Assignment administration defaults to disabled and all new ports independently deny live mode. Use invented data and existing finite trusted staff identities; these pages neither provision credentials nor list members or reviewers.

1. The member opens the ordinary private evidence page and shares its displayed exact evidence UUID and version. A revised upload needs its own consent, safety transition and review submission.
2. The reviewer uses the actual [staff sign-in form](PRIVATE-LOCAL-STAFF-ENTRY.md), then **My reviewer reference** to obtain their own noncredential UUID.
3. The administrator signs in and opens **Private sample assignments**. Enter those exact references and check them. The result contains only eligibility and the reviewer's current credential expiry. It does not contain the sample's title, source, member identity, feedback or credentials.
4. Enter an explicit finite UTC window in canonical millisecond form, for example `2030-01-02T12:00:00.000Z`. Check the confirmation box and submit. A window beyond the reviewer's expiry is rejected, not shortened. The server derives the submission, workspace, owner, actor, roles and exact purpose.
5. The reviewer finds the exact source in the existing worklist and uses existing feedback controls. Opening an assignment does not reserve or consume review time. A scheduled window grants no early access.
6. The administrator can inspect exact-source history and explicitly revoke one exact sample grant. Another valid overlap remains effective; the paired workspace assignment and other samples are untouched. Previously published feedback remains owner-readable while its source exists.

Only an explicit unambiguous selected staff cookie admits the new browser surfaces. A legacy-only credential cannot select this workflow. Every form independently checks current role and authority, exact Origin/Host, CSRF and bounded allowed fields. Permission checks are repeated on confirmation and downstream access; an earlier successful check is not an authorization promise.

## Receipts, uncertainty and history

One connection-owned transaction creates the dedicated reviewer workspace assignment, the exact `private_sample_feedback_v1` grant, two existing content-free authorization events and an immutable operation receipt. The confirmed window is identical for both grants. Existing independently committed grant APIs are not chained.

The original operation UUID is bound to the current administrator and the normalized source/version/reviewer/window. An identical repeat returns the original structural result. A changed payload conflicts without exposing the other payload's identifiers. Historical replay never creates replacement grants or renews authority.

If the response is uncertain, the original form retains only those allowlisted references, window and operation key. Its manual retry checkbox is unchecked. Choose **Inspect saved assignment in a new tab** to send a fresh authorized, CSRF-protected POST containing only the original key. The new tab uses `noopener`; the key is not placed in a URL or browser storage. Nothing is fetched or retried automatically. An absent receipt does not establish that nothing committed: workspace/account erasure removes its recovery record. Return to the retained original form; do not invent a new key or compensate solely because inspection was absent.

History has at most 20 rows per page, ordered by exact creation timestamp and grant UUID. The signed continuation binds the administrator's current token and exact evidence UUID/version, expires after the original 15-minute lifetime, and becomes invalid after server restart. Continuing never renews that lifetime. Pages are current observations rather than a frozen snapshot.

Existing exact sample grants appear without fabricated receipts. Actual operation receipts remain after source/grant deletion and report removed or ineffective state. Expired historical reviewers or grants do not prevent a current administrator from seeing safe structural history or revoking an extant exact grant. A deleting workspace or expired current administrator denies access. Inspection creates no grants, audits, feedback or accounting events.

## Storage, export and rollback

The additive `private_sample_assignment_operations` table stores historical UUID relationships, exact revision and confirmed UTC window. Its only cascading reference is the workspace. It contains no source/title/digest/feedback/token/consent copy and no pending-job state. Its immutability rule permits removal through workspace erasure, matching existing authorization history. No legacy operations are backfilled.

These relationships are personal-data metadata. Owner export v22 appends `sampleAssignmentOperations` after the existing 36 sections, preserving cursor v2, old section positions, 100-record and 256 KiB page bounds. Its safe projection contains receipt UUID, owned evidence UUID/version, recorded window, creation time and `retained-structural-receipt`. It excludes administrator/reviewer IDs, operation keys and internal paired grant IDs. Source deletion leaves that structural projection; workspace/account deletion removes it. Ordinary published-feedback export remains separate. See the [local deletion inventory](CTP-023-LOCAL-DELETION-INVENTORY.md).

To roll back new browser entry and assignments, set `DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION=disabled` and restart. Preserve the additive schema, receipt export and existing grants/feedback. In demo/test mode, compatible trusted `sampleAssignmentStore` methods `history`, `recover` and `revoke` remain available to a current administrator even when the creation flag is disabled. This is an API boundary, not a new CLI. All new store methods still independently deny live mode. Keep ordinary consent withdrawal, export and deletion available; do not restore an exporter that silently omits retained receipt metadata.

The transaction locks sorted principals and profiles before workspace, evidence, submission, assignment and exact grant. Its bounded authority is retained through PostgreSQL COMMIT, connection handback, HTML construction and HTTP acceptance. A valid ordered completion before a later revocation is distinct from fresh access after that revocation. No retry hides a lock/timeout failure or an uncertain commit.

This remains private synthetic local behavior. Original parent criteria, qualified staffing, formal assessment, full-MVP acceptance and deployment are separate.
