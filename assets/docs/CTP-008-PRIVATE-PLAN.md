# CTP-008: private starter-plan slice

**Issue:** [CTP-008 #28](https://github.com/deepnative/deep-native-engine/issues/28)
**Prepared:** 23 September 2026
**State:** local synthetic preview only; partial issue delivery

The member can give a goal, self-reported AI experience, an optional IANA time zone and a weekly time choice of 15, 30, 60 or 120 minutes. The same private learner record stores those values. The dashboard suggests a first week using only the existing 12-minute foundation lesson and its goal-specific sample exercise. A 15-minute choice suggests just the lesson and leaves the exercise for a later session; 30 minutes adds the exercise; 60 or 120 minutes also adds a check. The total suggested time never exceeds the selected weekly amount. When no amount is supplied, the page shows a starter lesson and asks for availability rather than claiming a tailored schedule. A time zone is displayed for context; the preview schedules no appointment.

Members may revise their direction and time choice. The plan reflects the latest profile on reload while the saved exercise keeps its original goal and version. Explorer, non-IT professional and IT backgrounds all have a noncoding path; background and experience do not grant staff access or a paid offer. The preview does not fabricate credentials, publish a curriculum pack, contact a provider or accept payment. The existing separate access/coaching hypotheses remain read only.

`migrations/009-learning-plan.sql` adds nullable time-zone and weekly-minute fields to `learners`; the application validates IANA names and allowed time choices and binds writes to the session-derived member. Existing rows remain valid with nulls. Deleting the preview removes these fields with the member record. The migration is additive and rerunnable. Rollback is to stop using the new fields/UI after preserving or deliberately clearing any local synthetic records; do not drop a populated column as a casual rollback.

Verification maps local browser scenarios L29–L31 to the three audiences, plus unit and real PostgreSQL cases for time bounds, invalid input, reload, goal revision, independent sessions, migration replay and deletion. The complete `make verify` gate must pass on the exact intended commit before push, in CI and on the resulting main commit. The full-MVP scenario register remains outstanding; a local slice pass is not a Phase B release.

Remaining #28 work includes production membership and recovery, fuller individualized plans and assignments based on reviewed prerequisites, distinct consent/access decisions, and any optional paid plan backed by approved terms and real expert capacity. PLAN-002 entity/market/privacy decisions, CTP-002 access/offer decisions and PLAN-003 capacity evidence block live acceptance. No deployment or commercial launch follows from this slice.
