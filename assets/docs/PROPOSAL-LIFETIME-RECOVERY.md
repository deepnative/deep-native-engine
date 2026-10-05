# Private proposal recovery

Scope: [#465](https://github.com/deepnative/deep-native-engine/issues/465), under privacy parent #42. Private invented-data preview only; no contribution license, publication, qualified assessment or commercial launch is established.

Members can create, inspect, correct, explicitly attest rights and submit a private proposal. Authorized moderators can request changes, quarantine or reject it. The owner can correct a returned revision, confirm rights again and resubmit, or withdraw and redact private text. Existing signed moderation pagination, export and erasure behavior remains in scope.

## When completion is unconfirmed

A database operation can commit even when its response arrives too late to confirm to the current session. An unconfirmed response is not proof that nothing changed. The application does not automatically replay the action.

- Creation: reopen **Your sample proposals** and look for the draft. Creation has no idempotency key; submitting the creation form again can make a second draft.
- Correction, submission or withdrawal: reopen the exact private preview and inspect its current revision, rights and state before another explicit action.
- Moderator decision: reopen the current private queue. A missing item does not establish which action happened. A fresh authorized read is required before deciding what to do next.

Recovery pages contain no stored private proposal text. Where correction or requested-change pages retain attempted text, it is the current request's input and is labelled as attempted, not confirmed saved content. An expired session cannot use a recovery link as a substitute for authorization.

## Operation boundaries

The proposal store reuses the bounded private transaction engine: at most three seconds for connection acquisition, five seconds per operation and ten seconds for the whole transaction, further limited by conservative database-observed actor expiry. Authority is checked through COMMIT acknowledgement and native connection handback. A late result is withheld. Unresolved commands do not receive a queued rollback, and owned connections are discarded; late acquisitions are discarded without querying. No mutation is replayed automatically.

Owner operations lock principal, workspace and proposal in that order. Creation and listing now use the same principal/workspace boundary. Listing locks proposals in UUID order, consistent with moderation, then presents them newest first. Moderator operations retain staff principal/profile, sorted member principals, workspaces and proposal locks. Existing rights/revision checks, source pins, signed page cursors and content-free audit records remain unchanged. Workflow-file validation inside writes is bounded too.

## Verification and acceptance limits

Unchanged main `4b7459d0933908ab150b2f2d9d3bc4d462927e0e` reproduced successful responses after actor expiry. Permanent PostgreSQL/HTTP tests cover ten owner/moderator operations at delayed successful COMMIT and synchronous handback; separate tests cover exhausted acquisition and unresolved query, COMMIT and rollback replies. Existing proposal integration tests retain erasure/revocation winner orders, exact rights/revision behavior, redaction, pagination and owned exports.

Browser scenarios L154–L156 extend the local register for general, professional and IT learners on both registered viewports. They exercise committed creation, moderation and withdrawal whose responses cross expiry, then recover through the current private UI without replay. Existing L113–L115 continue to cover the full revision/requested-changes journey and isolation. Report actual execution results on the issue; these descriptions alone do not prove a passing run or full-MVP acceptance.

## Rollback and operations

No schema migration or historical rewrite is introduced. Before rollback, pause the affected proposal endpoints and drain in-flight requests. Preserve all committed proposals and audit events; do not resubmit uncertain writes, delete possible duplicate drafts automatically or fabricate acknowledgements. The previous code can read the unchanged schema, but restoring its proposal handlers reopens the demonstrated late-response defect. Keep those endpoints unavailable until a bounded correction is verified. A missing response is not a rollback instruction.

Delivery requires exact-commit local/pre-push gates, recorded author review, PR and resulting-main CI, safe branch cleanup and a separate invented-data milestone demo. Broad parent #42 remains open for its other acceptance areas.
