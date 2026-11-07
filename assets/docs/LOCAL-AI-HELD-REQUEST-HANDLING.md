# Handling a held AI request

This is the data handling and deletion process for a held AI request, under the third acceptance criterion of [#187](https://github.com/deepnative/deep-native-engine/issues/187). It covers both metered and unmetered requests.

**No AI provider is connected.** Requests run against a local simulation, so nothing has actually left the system. This process exists so the behaviour is already correct and honest before any provider is added. It does not authorize one, and live dispatch of private evidence stays blocked on the provider facts recorded in #187.

## What a hold is

A request is held when an attempt started and we cannot tell what happened to it. A started attempt may have reached the AI step before anything went wrong, so it is never treated as failed, retried or closed. A held request has the status `needs_reconciliation` with the outcome `provider_outcome_unknown`.

A request becomes held when, after an attempt started:

- the AI step throws an error or does not answer usably
- its claim expires
- the member withdraws permission
- the member saves a new revision of the source
- the member deletes the source

A request that never started is cancelled instead, because nothing can have left the system.

## We cannot confirm erasure

Nothing in this system can confirm that a provider erased, never received, or never kept any data. Staff, the member page and this document must not say otherwise. Deleting a source, withdrawing permission or erasing an account removes what **this system** holds. It says nothing about anything outside it. A future provider connection must establish its own facts about receipt, retention and deletion, and record them on #187, before this wording can change.

## Who can do what

| Person                                             | Can                                                                                                                                                                        | Cannot                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Member who owns the request                        | See the hold and its reference on the permission page, even after deleting the source. Download it in their private record export. Delete the source. Erase their account. | Run, retry or release a hold. Withdrawing or granting permission again does not release it.                 |
| Platform administrator                             | Assign one other current operator to one exact held request for a fixed time, and revoke that assignment.                                                                  | Read the request through inspection, or assign themselves.                                                  |
| Assigned operator                                  | Read the request's safe metadata while the assignment is current. Record one labelled test outcome on it while it is held.                                                 | See any other request, source text or member identity. Change the job, its test unit or a recorded outcome. |
| Anyone else, including other operators and coaches | Nothing.                                                                                                                                                                   | Learn whether a request reference exists: every refusal looks the same.                                     |

There is no way to retry, refund, release or close a hold. An assigned operator can record a **test outcome** (below), but that is a label on invented test data, not a resolution. Real resolution needs a provider's own evidence and stays gated in [#189](https://github.com/deepnative/deep-native-engine/issues/189).

## Recording a test outcome

An assigned operator opens the request's snapshot and follows **Record or read its test outcome**. They choose:

- an outcome: the request ran, or it did not run
- a reason: an invented test record matches the request, or it was recorded as part of an operator test exercise
- a reference to the invented test record, which must start with `test-` and use only lower-case letters, digits and hyphens

No free text is accepted, so source text, prompts and provider messages cannot be entered. Every page says no AI provider confirmed the outcome.

- **One per request, never changed.** The database refuses any change or deletion except through account erasure. Sending the same form again shows the recorded outcome. A different outcome, from the same form or a new one, is refused and the first stays.
- **It freezes the job.** After an outcome is recorded, the database refuses any change to the job's status, attempts, claim or error. A worker whose claim expired cannot complete or fail it, and no one can run it again. If the claim had expired but not yet been marked held, recording the outcome holds it first, in the same transaction.
- **It changes nothing else.** It does not charge, refund, release or consume a test unit, settle usage, retry, or change what the member sees.
- **Only a current exact assignment.** The operator needs an unrevoked, unexpired assignment to that request. Members, other operators and administrators are refused the same way. It is off whenever inspection is off, and never available in live mode.
- **Deletion and erasure.** Deleting the source keeps the outcome with the hold. Once account deletion starts, the outcome can no longer be read. Erasure removes it.

## Process for a held request

1. **The member sees it.** The permission page says the outcome is unknown, that the request will not run again, and that nothing is confirmed erased. It shows a request reference.
2. **Find the exact request.** There is deliberately no list of held requests across members. An administrator works from a reference the member gives them, for example through private support, or from a controlled invented-data fixture.
3. **Assign one operator.** Follow [hold inspection](PRIVATE-LOCAL-AI-HOLD-INSPECTION.md). The assignment names one request, one operator and one fixed purpose, ends at a set time, and leaves a content-free record of who made it. An unmetered request can only be assigned while its outcome is unknown.
4. **The operator reads the metadata.** Inspection is off by default and is never available in live mode. Reading changes nothing.
5. **Revoke when finished.** The administrator revokes the assignment, or it expires. Revocation still works while inspection is paused. A page already on screen cannot be recalled.
6. **The hold stays.** It remains until the member erases their account. Do not edit the database to close one, reset a claim, infer a refund or send the request again.

## What is kept and what is removed

| Event                       | Removed                                                                                                 | Kept                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Member withdraws permission | Nothing. Future runs are stopped.                                                                       | Source, permission record marked withdrawn, and the hold                              |
| Member saves a new revision | Nothing. The old version can no longer be used.                                                         | Old version, retired permission, and the hold                                         |
| Member deletes the source   | Source text, file name, stored files and permission record                                              | The hold, with its link to the permission cleared, plus any assignment and its events |
| Member erases their account | The hold, its test-unit link, every assignment and event, any test outcome, and all other owned records | Other members' records only                                                           |

### What a kept hold contains

A kept hold contains its reference, status, safe error code, attempt count, times and the fixed mode, operation, prompt and model version labels. If the request was metered, it also keeps its test-unit link and cost estimate.

It also keeps two one-way hashes: the request fingerprint and the idempotency key. The request fingerprint is derived from identifiers and the source's digest. Neither can be reversed to recover the text, and neither is shown to staff or included in the member's export.

It contains no source text, file name, prompt, output or credentials.

### Why deleting a source keeps a hold

The hold is the only record that something may have left the system. Without it, neither the member nor staff could answer whether a deleted source was ever in flight, which is the point of holding it. Metered requests already behaved this way, and the privacy question is the same with or without a test unit.

The cost is that a member who deletes a source keeps a content-free record of the request until they erase their account. There is no automatic expiry yet. The member page says this plainly, and account erasure removes it.

Source deletion is never blocked. A request that never started, succeeded or closed is removed with its source, as before. The one exception is a request that already has an inspection assignment but finished after its claim expired: it stays because the assignment's audit trail depends on it, and it is not listed as a hold.

## Known limits

- Requests closed as `exhausted` before this behaviour existed are not reclassified. No provider has ever been connected, so none of them reached one.
- If the session or source stops being valid just after a claim, `run` still closes an unmetered attempt as `exhausted`. The AI step has not been called on that path.
- There is no retention period, automatic expiry or staff queue for holds. A live provider would need those decided first.
- A test outcome does not appear on the member's page or in their export. It records which operator decided, which the member should not see.
- A test outcome does not settle or release the test unit. That needs a release and charge policy tied to a real provider's evidence (#189).
- This process has had no legal or privacy review. It records current system behaviour and is not a commitment to members.

## Rollback

Migration 111 adds test outcomes and the job freeze. Turning inspection off also turns off recording, and reverting it removes both the table and the freeze. Do not revert it while outcomes exist without first deciding what should happen to frozen jobs.

Migration 107 lets assignments link directly to the job and keeps held requests when a source is deleted. Pause inspection with `DNE_LOCAL_AI_HOLD_INSPECTION=disabled`. Do not reverse the migration while unmetered assignments or sourceless holds exist: the earlier foreign key cannot represent them, and the earlier trigger would go back to deleting the record of an unknown outcome.
