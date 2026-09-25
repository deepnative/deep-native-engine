# CTP-005: workspace authorization and staff grants

Issue [#24](https://github.com/deepnative/deep-native-engine/issues/24) makes the local synthetic identity boundary explicit. An opaque browser credential is hashed before lookup; PostgreSQL resolves it to one unrevoked, unexpired member or staff principal. Request parameters never select the acting identity. No live identity provider, real account recovery or production member record is part of this slice.

## Authorization matrix

| Actor | Private member workspace | Shared cohort content | Conditions |
| --- | --- | --- | --- |
| Owning member | Read owned records | Read explicitly permitted cohort items | Principal and membership active |
| Other member | Denied | Only their own explicit membership | Background and goal have no privilege effect |
| Coach | Read assigned workspace | Denied by staff identity | Matching coach grant, purpose, start, expiry and no revocation |
| Reviewer | Denied for raw exercise drafts | Denied by staff identity | An assignment alone never shares draft responses; separately submitted evidence needs the exact active grant described in [CTP-010](CTP-010-EXACT-EVIDENCE-GRANTS.md) |
| Editor or moderator | Denied | Denied by staff identity | Role alone never grants member data |
| Operator or platform administrator | Denied by role alone | Denied by staff identity | Exact-purpose support grant is active; every successful read is audited |

Only a current platform administrator can create or revoke assignment/support grants through the trusted authorization service. No HTTP route provisions identities or grants roles. Learner onboarding ignores caller-supplied IDs and role fields. Cohort membership authorizes one cohort's explicitly shared content and does not create staff or private-workspace access.

## Data and request boundaries

Migration `003-workspace-authorization.sql` adds global principals, member-owned workspaces, typed staff profiles, assignment grants, support-access grants, support-read audit rows, cohorts and explicit membership/content relationships. The application authorization interface only appends audit rows; database operators retain ordinary maintenance authority over the table. Exercises carry both learner and workspace IDs under a composite foreign key, so the database rejects cross-workspace record joins even if application code is wrong.

`GET /api/workspaces/:workspaceId/private` returns content only after the server hashes the cookie credential and resolves ownership, an active coach assignment, or an exact-purpose support grant. A denied response is always `403 {"error":"forbidden"}` and does not reveal whether the workspace exists. `GET /api/cohorts/:cohortId/content/:contentId` requires an active member principal and an exact readable membership/content pair. API responses and routine errors exclude credentials, token hashes, internal grant IDs and private data from denied requests.

The original synthetic CTP-005 slice permitted a reviewer assignment to read this raw workspace route. [#217](https://github.com/deepnative/deep-native-engine/issues/217) supersedes that permission: the route now accepts coach assignments only, because these exercises have no reviewer submission consent or version-bound grant. Reviewer access to an exact, owner-submitted evidence object is a separate path; no formal assessment or assignment-response access is inferred.

## Expiry, revocation and audit

- Principal expiry or revocation denies every later request.
- Coach/reviewer grants are workspace-specific, role-matched, purpose-labelled and time-bounded.
- Revocation is checked on every read; no cached authorization survives it.
- Editor, moderator and ungranted operator/administrator roles have no private-member access.
- Support reads require the exact stored purpose and insert one `support_content_read` audit row in the same PostgreSQL statement that authorizes the read.
- Member background/goal changes and cohort membership do not modify staff profiles or grants.

## Operations and rollback

This is an additive local schema migration. Deleting a member principal cascades through its learner profile, workspace, exercises, memberships, workspace grants and related support-read audit rows. Staff principals and grant-issuing administrators with referenced grants or audit rows may be restricted from deletion by foreign keys; revoke them and apply an approved retention process instead. Audit rows remain while their referenced support grant and workspace remain. Production retention, database-role restrictions and deletion-exception policy remain deployment decisions.

Before live identity or real member data, separately approve the identity provider, account verification/recovery, stable secrets, retention, jurisdiction, incident response, administrator bootstrap/rotation and backup/restore procedures. Rollback before live use is an application/schema revert in an isolated environment; never drop a populated production authorization schema automatically.

## Acceptance evidence

Unit contracts cover validation, fail-closed defaults, role/grant operations, safe direct reads and every denial branch. PostgreSQL integration covers ownership, cross-record constraints, administrator-only grants, coach/reviewer assignment, editor/moderator/operator denial, expiry, revocation, exact-purpose audited support and cohort isolation. Browser journeys `L15`–`L17` exercise the same boundaries through the compiled application on desktop and mobile Chromium. The shared gate retains every prior journey and all 27 outstanding full-MVP requirements.
