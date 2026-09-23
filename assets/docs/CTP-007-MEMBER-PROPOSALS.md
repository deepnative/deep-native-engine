# CTP-007: private sample proposal intake

Prepared 2026-09-23 for [CTP-007 #26](https://github.com/deepnative/deep-native-engine/issues/26), claim `ctp007-proposals-netcsc-20260923`. This is a local, synthetic moderation slice. It does not grant a contribution license, approve real member content, qualify an expert, or publish a proposal.

Migration `008-member-proposals.sql` stores a member-owned draft separately from the published content library. Saving requires the member's explicit sample-information attestation; submission requires a separate original-rights confirmation. Only the active owner may read, submit or withdraw it. A current moderator or platform admin can read submitted/quarantined items through one authorization-bound SQL statement, quarantine them or reject and redact them. There is deliberately no accept, transfer-to-catalog or publish action. Withdrawal atomically redacts title/body/sources and removes the item from the moderation queue. Member account deletion cascades through proposals. CSRF and origin checks apply to every form action.

The `initial-learning-v9` browser register adds L28 for a general member, another member, a reviewer and a moderator, including redaction and absence from the library. PostgreSQL integration covers ownership, rights attestation, role denial, rejection, withdrawal and deletion. The 100 proposed full-MVP cases remain uncovered; this is local preview evidence only.

## Remaining decisions and acceptance

The owner must define contribution licensing, attribution, retention, moderation appeals and approved publication rules before real member submissions or public contribution release. Qualified curriculum/domain sign-off for PLAN-004 remains pending by owner direction. Formal assessment, accessible production review and the complete member-to-reviewer journey remain open. The current implementation has no draft edit path or production retention job. If the slice must be rolled back, stop its routes, export only authorized synthetic records if needed, then drop `member_proposals`; no published catalog item depends on it.
