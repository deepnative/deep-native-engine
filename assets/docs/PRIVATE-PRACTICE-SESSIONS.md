# Private sample practice conversations

Scoped delivery: [#424](https://github.com/deepnative/deep-native-engine/issues/424), advancing #200/#34.

Members explicitly opt into invented-text-only practice from an eligible current published synthetic lesson. A conversation pins the exact source version, learning goal and repository prompt version. Each accepted response is paired with a stored deterministic comparison and bounded source excerpt. The initial instructions do not count toward the limit of 30 visible turns: at most 15 response/comparison pairs. These prompts are simulated and unreviewed, express uncertainty and cannot judge competence. No provider, job, paid quota, entitlement or ledger is invoked. Existing one-note practice remains available separately.

Owner history remains available after goal changes or source retirement. A submission overlapping publication of a replacement version may complete against the exact source that was eligible when it was read; subsequent submissions must use current eligibility and cannot continue the replaced source. This preserves the pinned history without silently retargeting a response. New pairs require the same current goal and eligible exact source/template; the application does not silently retarget a conversation. Exact duplicate response submissions replay their original pair; conflicting submissions cannot overwrite it. Withdrawal removes every response-derived byte and leaves a content-free marker that prevents reopening the same slot. Account deletion cascades all owned sessions/exchanges.

History has bounded keyset pages, and a detail has at most 15 pairs. Structured member export includes all retained session metadata and exchanges through the existing authenticated 100-record/256-KiB pagination. Practice delivery introduced payload `local-member-records-v13` with these two sections; the current support addition uses v14 with later appended sections; cursor v2 preserves existing section indices. Pages remain live reads, not one immutable snapshot across requests.

## Failure and rollback

Failed or uncertain writes return generic non-success and never replay automatically. Reload owned history to inspect actual durable state. Expiry, revocation or deletion during lock waits denies or rolls back; a failed rollback discards the connection.

Before any data exists, revert the feature and additive migration together. After data exists, keep schema and owner read/export/withdrawal and disable start/append if rollback is required. Running an older binary that omits session portability is not a complete rollback.

## Evidence boundary

L103–L105 extend approved local browser coverage to opt-in/multiple response/reload/cap, isolation/unavailable-source history, and export/withdrawal across three backgrounds on desktop/mobile. This changes the local register from 102 to 105 journeys; existing IDs and mandatory variants remain. Full-MVP acceptance, qualified curriculum review, live AI and paid-service criteria remain separate open requirements on #200/#34. Record actual verification results in the issue/PR before delivery closeout.

## Session lifetime and uncertain replies (#453)

Practice source, start, history, detail, response and withdrawal operations use the
same bounded transaction boundary. Principal, workspace, source and session locks
retain their existing order. PostgreSQL validates remaining authority after the
principal lock and again before commit; monotonic elapsed time includes query
transit, commit reply and native connection handback. A delayed reply cannot extend
an expired session's authority or expose its private result.

The whole operation has a 10-second budget, acquisition at most 3 seconds and each
query/commit/known rollback at most 5 seconds, further restricted by remaining
operation and authority time. Server statement and lock timeouts remain 5 seconds;
the transaction timeout uses the remaining operation budget. Missing or malformed
clock evidence fails closed. A connection acquired too late is discarded. An
unresolved operation is never followed by a queued rollback or automatic replay;
its owned connection is discarded. Known rollback is bounded. Native release is
synchronous and cannot be preempted, but its elapsed time is checked before returning
any result.

A denied or unavailable response does not prove a submitted write was undone.
A successful PostgreSQL commit can outlive its acknowledgement. Re-establish valid
member authority and inspect saved history before deciding what to do next. The
server does not automatically resubmit the write. Published source/goal/prompt
pins, replay/conflict semantics, pair limits, withdrawal and export remain unchanged.

No schema or retention policy changes are needed. To roll back safely, pause the
affected practice operations while retaining their stored records and existing
export/deletion paths. Restoring the older transaction reader also restores the
known expiry defect; it is not a privacy-preserving recovery. This local correction
does not establish hosted deployment, live AI, paid capacity or qualified review.
