# CTP-022 local preview metrics slice

The operator-only `GET /operator/metrics` endpoint returns one aggregate snapshot from the local preview database. It accepts only an active, unrevoked `operator` or `platform_admin` staff principal. It never returns member IDs, profiles, evidence or per-member drill-down. Every response is labelled `synthetic-local-preview`; none is a live business KPI. The timestamp is the database statement time. No external analytics provider receives these data.

The fixed denominator for every rate is the number of **retained** learner rows at that timestamp, including members whose sessions expired or were revoked. A privacy deletion removes the learner and all linked events; the snapshot cannot reconstruct prior deleted members, so it is not a durable acquisition cohort. Zero members means the rate is undefined, not zero success. The endpoint supplies counts and definitions, not a rounded or potentially misleading rate.

- Activation counts each member with at least one versioned lesson open once. Opening is observed but does not establish learning.
- Completion counts each member with at least one self-assessed lesson completion once. It is member reported, not a formal assessment or observed skill.
- Participation counts each member who has ever joined a synthetic local circle once. Leaving does not erase this history or remove the member from its denominator.
- Active circle count includes each member with at least one circle membership that has no `left_at`; it is a state count, not participation volume or expert attendance.

Counts are computed from the same database statement, avoiding mixed-time totals. The aggregate intentionally has no small-segment or individual filters. Cohort and overlapping background/goal segmentation, continued learning, reviewed contribution quality, usefulness, paid conversion/renewal, ledger/provider reconciliation, service cost and capacity are not represented. Those require their own event semantics, privacy review, source readiness and evidence before a full-MVP metric or public report can claim them. The outstanding ECO-08 full-MVP journey remains open.

The approved local browser scenario L47 checks operator access, member denial, synthetic labelling and count changes after onboarding and joining. Real PostgreSQL integration tests check duplicate-safe counting, a departed circle member, an expired member in the denominator, and staff revocation. This slice does not qualify curriculum, launch services or indicate real demand.
