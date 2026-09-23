# CTP-018: private goals and milestones slice

**Issue:** [CTP-018 #36](https://github.com/deepnative/deep-native-engine/issues/36)
**Prepared:** 23 September 2026
**State:** local synthetic preview; bounded delivery slice

A member can save a concrete learning/project goal and practical milestone, an evidence note, a next action, and an optional local reminder date and time. The member may revise or delete the entry and may mark it complete only with a substantive evidence note. Completion is explicitly self-reported, not a verified skill or commercial result. The same path works without coding, a job title, a client or a paid plan. No job feed, proposal send, external reminder or appointment exists.

Migration `011-learning-milestones.sql` stores this mutable, private state in PostgreSQL with an owner foreign key that cascades on member deletion. Reads, updates and deletes require the session-derived member ID. Update/delete forms carry a version; stale tabs cannot silently overwrite or remove a newer entry. Form writes retain the existing Host, Origin and CSRF checks. All user text is escaped in the HTML page. Invalid or failed writes do not claim success.

Reminder values are local wall-clock date/time and the profile time zone captured when the entry is saved. They are displayed on the member page only. Changing the profile time zone leaves an existing reminder's saved zone unchanged; editing and saving that reminder intentionally adopts the current profile time zone. No scheduler, email, device notification or provider call is connected. Members without a profile time zone must set one before adding a reminder. This local display does not establish a live notification service or a DST-aware delivery promise.

Browser journeys L35–L37 cover an exploratory general learner, a non-IT professional and an IT learner on desktop and mobile. Unit and real-PostgreSQL cases cover validation, privacy, stale edits, deletion and cascade. The complete `make verify`, pre-push, PR CI and resulting main CI must pass on their exact revisions. The separate full-MVP register remains outstanding.

Optional career/opportunity/contract tracking, approval-gated unsent professional drafts, production identity and recovery, external reminders, verified evidence and commercial outcomes remain outside this slice. Create linked open follow-ups for unmet #36 criteria before Done closeout. Rollback is to hide the local page after preserving or deliberately clearing private synthetic entries; do not drop a populated member table casually.
