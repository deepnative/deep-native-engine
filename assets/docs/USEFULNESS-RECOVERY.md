# Private lesson usefulness and recovery

After self-assessing a sample lesson, open your private learning activity to say whether it helped. You can correct or withdraw your answer. An answer belongs to your account and the exact lesson version; it is self-reported, not a qualified assessment.

If the result cannot be confirmed, the application shows **Usefulness response unconfirmed**. The request may already have completed. It does not automatically repeat your save, correction or withdrawal. Use **Check current private activity** to read the saved state before deciding on another action. An expired or revoked session cannot use that link to recover private information; renewed authority in automated tests is only an invented fixture, not a public session-renewal facility.

A fresh authorized read shows the committed answer and revision, or its absence after withdrawal. Stale corrections cannot overwrite a newer answer. Historical withdrawal, account deletion and private export retain their existing behavior. This does not change aggregate analytics, retention policy, foundation access or qualified review.

## Operation boundaries

Issue #469 reuses the existing bounded transaction helper: connection acquisition is limited to three seconds, a database operation to five seconds, and the transaction lifecycle to ten seconds. Database-observed session expiry may shorten those limits. The principal and workspace fences retain their order before activity, content and report rows. Authority is checked before the mutation and before COMMIT; elapsed reply and native connection handback time cannot turn expired authority into a success acknowledgement. Late or unusable connections are discarded. An unknown pending query/COMMIT is not followed by a queued rollback or mutation replay.

Definite authorization denial remains separate from an authorized eligibility or revision conflict. Unconfirmed outcomes use a sanitized HTTP 503 recovery page without private payloads, database exception details, a mutation form or a claim that nothing was saved.

## Verification and rollback

The regression suite covers successful late COMMIT replies and handback for save, correction and withdrawal, plus stalled operations, rollback, exhausted/late acquisition, existing races and retained state. Local journeys L160–L162 exercise three learner backgrounds on desktop/mobile. These are private synthetic checks, not accepted full-MVP, production, deployment or qualified-review evidence.

There is no schema migration. To roll back, pause the usefulness mutation endpoint, drain outstanding work, preserve committed answers and revisions, and restore the prior application revision. The prior revision reopens the false-success defect; do not describe rollback as a privacy fix or replay unconfirmed requests. Keep fresh authorized readback available while investigating.
