# CTP-003 learner profile slice

Date: 2026-09-23. Issue: [CTP-003 #20](https://github.com/deepnative/deep-native-engine/issues/20). Claim: `ctp003-netcsc-20260923`. This is a bounded local preview contribution, not completion of the expert-coverage issue or authorization for live service.

## Behavior and decision

The common foundation remains available to general learners, non-IT professionals and IT practitioners. A member chooses one primary starting point and goal, and may add overlapping background tags, domain interests, one or more of the nine named IT specialties (or other IT specialty), experience with AI, and an exploratory path. None is an admission, staff-role, entitlement, price or contractor determination. The member can revise these choices from the learning path without entering a job, client, contract or payment detail.

Migration `005-learner-profile.sql` adds optional arrays and state to `learners`; existing rows receive empty arrays, no stated experience and no exploratory flag. The original primary background and goal remain for compatibility with the current lesson choices. The server validates every selection against a bounded catalog, derives the learner ID from the session, and keeps CSRF and same-origin checks on updates. Direct SQL remains an operator concern; this preview exposes no profile update by caller-provided ID.

An exercise now records `goal_at_start` when first saved. Changing the goal leaves the exercise and its lesson version untouched and shows the earlier prompt and a context note. Historical exercise rows predate this field and have no recoverable original goal; they display using the current goal. This limitation is explicit rather than fabricating a historical value.

## Verification map

The executable [initial-learning-v5 register](../../tests/e2e/scenarios.json) adds L21–L23 for general, non-IT and IT learners. They exercise optional tags and experience, exploratory choice, goal revision, persistence across reload, and preserved practice context on desktop and mobile Chromium. Unit tests cover invalid/duplicate/out-of-catalog selections and owner-bound updates. The existing integration migration test reruns both authorization and profile migrations over populated data; the full gate checks all prior journeys and quality thresholds. The full-MVP register retains its 27 outstanding requirements.

Record the exact `make verify` report and commit SHA in the live issue or PR. A passing local preview does not establish qualified expert coverage, a published specialized track, or a ready tailored service.

## Remaining CTP-003 work

- Define and record reviewed content and true track states: available, limited coverage, in preparation and retired.
- Build the qualified expert registry with role/domain, service types, coverage dates, costs, backup and capacity; validate qualifications and service readiness with an accountable human owner.
- Gate any tailored service commitment on published content and actual qualified coverage. General foundation access must stay independent of that manual specialist review.
- Review audience-dependent evidence for the full issue, obtain independent review, and close only after every acceptance criterion and definition-of-done item is evidenced.

Rollback of this slice is application rollback to the prior commit; the additive database columns can remain safely unused. Dropping them would discard new member preferences and requires an explicit data migration decision. No live provider, hosted identity, payment or release state is changed.
