# CTP-018: optional private career planning

**Issue:** [#107](https://github.com/deepnative/deep-native-engine/issues/107), following the [local goal/milestone slice](CTP-018-PRIVATE-MILESTONES.md). **State:** synthetic local preview only.

A member's ordinary learning path has no career or client fields. The separate career page is off by default; the member must opt in before entering an optional career goal, opportunity or contract record. Each record has a private title, note, next action and optional outcome. Outcomes are labelled self-reported and are never treated as verified employment, client demand or income. The page accepts only invented or sample information.

The member can also keep professional, proposal or renewal drafts. Each draft starts unapproved and unsent. Approval is a deliberate checkbox/action tied to the current saved version. A stale version cannot be approved, changed or deleted; editing resets approval, and the member can withdraw approval. Approval is a local planning state only. There is no recipient, send endpoint, job marketplace, client introduction, payment or external provider. This is distinct from the existing member-contribution proposal moderation flow.

Migration `012-private-career-planning.sql` stores an opt-in row and two member-owned tables in PostgreSQL. The tables cascade from the opt-in row and member identity. Turning off this path explicitly deletes all optional records and drafts while preserving ordinary learning milestones and practice. Server routes derive the member ID from the active signed session, use bound SQL parameters and version checks, and retain the shared Host, Origin and CSRF gate. User text is escaped on rendering. A failed write does not claim success.

Browser journeys L38–L40 exercise general, non-IT professional and IT members on desktop and mobile, including opt-out preservation, stale approval, cross-member denial and forged CSRF. Unit tests cover validation, route outcomes and safe storage boundaries; real PostgreSQL tests cover version transitions and cascading deletion. `make verify`, pre-push and CI must pass at their exact revisions. The separate full-MVP register, production identity/recovery, live career services and all commercial claims remain outstanding.

Rollback: hide the optional page or restore the prior application revision while preserving member-owned rows. Do not drop a populated table without an explicit data-retention decision; opt-out and member deletion are the only automatic destructive paths in this slice.
