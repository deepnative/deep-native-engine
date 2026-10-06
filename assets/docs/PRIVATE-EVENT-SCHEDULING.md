# Dated private learning rehearsals

This local feature schedules an invented learning rehearsal from the trusted repository template. It is not a real clinic, staffed service, recording, attendance record or paid booking. A member's background or learning goal never grants administrator access.

## Enable and use

Run in demo/test mode with PostgreSQL and the standard private-preview setup. Explicitly enable `DNE_LOCAL_STAFF_ENTRY`, `DNE_EVENT_REGISTRATION`, `DNE_LOCAL_EVENT_ADMIN` and `DNE_LOCAL_EVENT_SCHEDULING`. Scheduling defaults to disabled. Provision finite trusted local administrator authority using the existing setup procedure; no page grants staff authority or reveals a staff directory.

Sign in at `/staff/sign-in`, choose **Schedule a private rehearsal**, and enter a canonical UTC start such as `2026-10-07T15:30:00.000Z`. Choose an actual future date: the database clock requires a start two minutes to thirty days ahead. Check the proposal, review the readonly trusted template, title, duration, date and sample capacity, then deliberately select the initially unchecked confirmation. The canonical receipt links to the new member event detail. The original static template and its dates remain unchanged.

Members discover the new goal-applicable event using their own learner access, deliberately enroll through the existing local-registration flow, and retain their own exact-version receipt. Existing administrator cancellation closes new enrollment while preserving member receipts. Voluntary withdrawal is separate from cancellation. Members can export or erase their own registration data.

## Unconfirmed writes

An unavailable result may already have committed. Keep the original instruction and key. Use the protected **Inspect saved result in a new tab** action before deciding whether to deliberately repeat that same instruction with the same key. The page never retries automatically or substitutes a key. A missing inspection result is not proof that an earlier uncertain instruction cannot finish. A foreign creator or changed snapshot cannot reuse a reserved key. Operation keys are absent from member pages and exports; never publish staff credentials or recovery forms.

## Pause and compatibility

Disable `DNE_LOCAL_EVENT_SCHEDULING` and restart the current compatible runtime to pause new scheduling. This preserves the shared catalog readers, existing receipts/export, enrollment (if separately enabled), exact cancellation and historical protected inspection/replay. Disabling registration separately denies new enrollment. Rehearsal admission is bounded to twenty future open dynamic rehearsals; cancellation or time passing can free scheduling admission without inventing new member seats.

Migration 063 adds scheduling provenance, an admission fence and immutable operation receipts. Trusted learning content stays in Git files; dynamic dates, immutable source snapshot and scheduling receipts stay in PostgreSQL. Applying the migration to populated earlier inventory preserves its records, and reapplication preserves saved new schedules. An administrator's erasure removes actor linkage while retaining the reserved operation and content-only schedule. A member's erasure removes their owned registrations without deleting that schedule.

Pause new creation using the current compatible runtime if rollback is needed. No destructive down migration is supplied. Do not run an older binary against saved dynamic rehearsals and assume its readers preserve them; older-binary compatibility is not established. Back up according to the existing private-preview procedure before schema changes. Do not edit immutable template version1 in place; changing trusted content needs a separately versioned compatibility design.

## Evidence boundaries

Issue #487 tracks the eight REHSCHED acceptance scenarios; see [the executable evidence map](PRIVATE-EVENT-SCHEDULING-EVIDENCE.md) for current results and outstanding delivery gates. Local tests and invented-data browser journeys do not establish full-MVP acceptance, qualified curriculum/accessibility signoff, real attendance, expert coverage or deployment. Parent #119 retains those broader acceptance areas.
