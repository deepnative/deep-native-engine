# Private reviewer worklist

Issue #461 adds local reviewer discovery at `/review/worklist`, accessible from the staff library and individual feedback pages. Use invented samples only. This is not qualified routing, staffed capacity, a booking system or a response-time promise.

## Main journey

A current reviewer needs both a current workspace assignment and an exact `private_sample_feedback_v1` grant. A staff role alone exposes no tasks. Existing feedback setup and grant controls remain in [the feedback guide](PRIVATE-SAMPLE-FEEDBACK.md).

Open Active to find unstarted samples, your saved drafts and published feedback awaiting your clarification answer. Publishing moves a task to Completed; a new owner clarification returns it to Active; answering returns it to Completed. Opening or listing a task does not begin timed work, create a grant or publish feedback.

Each row contains the sample title, version, submitted time, observed age and your feedback state. Source text, comments, member names and other reviewers' drafts are absent. Detail links independently check current permission. The list never reads private source object storage.

Pages contain at most 20 tasks, oldest submission first with an ID tie-breaker. Next-page cursors are bound to the reviewer session and selected view, expire after 15 minutes and become invalid after server restart. Start again from Active or Completed after an invalid cursor. Concurrent changes can alter page membership; this is not a frozen snapshot.

## Permission changes and failure recovery

Every page checks current identity, role, assignment, exact purpose, consent, quarantine and submission state. Withdrawal, deletion, expiry or revoked grants remove access. Changes during discovery or an uncertain database outcome withhold the whole page. Use fresh navigation after resolving the condition; no automatic retry is performed. Content-free audit records contain only relevant IDs and the read action.

## Pause and rollback

Set `DNE_REVIEWER_WORKLIST_READS=disabled` and restart the local process to return an unavailable worklist. The default is `enabled`; other values fail configuration validation. Direct feedback routes, grants, withdrawal, export and deletion remain governed by their existing controls. Remove the worklist routing/store and navigation to roll back this feature; no migration, authority backfill or new persisted queue is introduced. Preserve feedback and audit history.

## Verification scope

The dedicated integration suite exercises 105 same-time samples across three owners, six-page completeness, duplicate grants, state transitions, revocation and deletion races in both observed lock orders, and expiry through COMMIT and connection handback. Browser journeys L148–L150 exercise explorer, professional and technical backgrounds on desktop and mobile, including valid 200-character titles through member queueing and reviewer discovery. This is local synthetic evidence, not accepted full-MVP or qualified review evidence. Final exact-commit and CI results belong in the issue closeout.
