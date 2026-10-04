# Private review test minutes

Issue [#458](https://github.com/deepnative/deep-native-engine/issues/458) connects explicitly reserved local review test units to publication of saved private sample feedback. This is an invented-data rehearsal, not a paid review, qualified assessment or staffing promise. Delivery and full verification are still pending.

## Member and reviewer journey

Use a dedicated local preview database and private storage directory. Enable new work with `DNE_REVIEW_TIME_WRITES=enabled`; the default is disabled and live mode refuses allocation and publication with test minutes. This feature creates no allowance. A trusted local fixture must already have explicitly seeded the member's `review_minutes`; other unit categories cannot fund this work.

The member uploads an invented text sample, consents to private review, and queues its exact safe source version. From its feedback page, open the review-allocation form and reserve 1–120 whole minutes. Keep the operation reference until the result is confirmed. At most one unresolved allocation exists for that submission.

A local administrator uses `reviewTimeGrants(pool, { enabled: true, mode: "test" }).grant(adminToken, allocationId, reviewerId, startsAt, expiresAt, operationId)` to grant the exact allocation. This internal operation is separate from the current reviewer workspace assignment and exact `private_sample_feedback_v1` source permission described in [the feedback guide](PRIVATE-SAMPLE-FEEDBACK.md). All three are required. Tokens remain in private local credential files, never command arguments, URLs, repository files or screenshots. Grant and revoke operations record metadata-only audit events. There is no automatic reviewer assignment or public grant endpoint.

The reviewer opens the exact feedback page and explicitly chooses **Begin reserved review**. Reading alone starts nothing. Begin pins the reviewer and time grant. Save the feedback draft, then enter whole-minute UTC review and optional preparation intervals within the preceding 24 hours. Publish the exact saved draft. Ten review plus five preparation minutes against a twenty-minute allocation consumes fifteen and returns five in one transaction. Expired returned units remain expired, not newly spendable.

Draft numeric time observations remain separate, self-reported and unbilled. They are not converted into settlement intervals or retroactively charged. A sample without a review allocation retains its existing unbilled publication flow.

## History, stopping and recovery

Members inspect their receipts at `/review-minutes`. Pages contain at most twenty owned receipts. An unused allocation can be cancelled once, including while new writes are paused. Source withdrawal or erasure before begin releases the hold. After begin, withdrawal or erasure retains unresolved minutes for reconciliation; no completion, refund or reassignment is invented. Reviewer access stops when its current source or permission is unavailable.

Deleting a source first marks it unavailable and removes private source/feedback links. Only owned accounting metadata remains; account/workspace erasure removes that owner's records under existing semantics. Export v21 appends allocations, effort entries and metadata events at section indices 33–35, preserving every earlier section index and the existing 100-record/byte limits.

A timeout or lost acknowledgement can conceal a committed result. Inspect owned history or the original receipt with fresh authority. Allocation recovery offers the original operation and ceiling explicitly; it never automatically retries. Exact publication replay is idempotent; a changed draft or interval is a conflict. An uncertain allocated publication offers an explicit “Reconcile original publication” form with the original operation, saved draft revision and intervals plus a fresh CSRF token. Inspect saved feedback first; submitting that form never starts a different operation. Do not use a new operation to infer that the earlier one failed.

## Transaction boundaries and rollback

Current identity and member workspace ownership are rechecked. Reviewer writes lock current identity/profile and the shared actor exclusion before workspace, source, submission, assignment, exact publication grant, allocation-specific grant, feedback/allocation and ledger rows. The shared actor advisory lock uses namespace 44154 and is also used by existing support-time writes; database triggers reject overlapping support/review effort. Grant administration locks sorted identities/profiles before workspace/source/allocation; revocation locks its current administrator and workspace before the time grant. Source erasure establishes its unavailable state before removing bytes and links.

The bounded transaction helper limits acquisition to three seconds, individual query/driver stages to five seconds and total operation lifetime to ten seconds. Database-derived authority is retained through COMMIT and native connection handback. Unknown operations discard the owned connection without automatic replay or queued rollback.

Migration 058 is additive and repeatable. It adds constrained review allocations, exact grants, unit attachments, immutable entries and audit events, plus old-writer protections. Existing published feedback and numeric observations gain no cost, grant or effort backfill. Generic ledger calls cannot settle protected review reservations. Publication, interval recording, consumption and unused release commit together.

For a compatible rollback, disable new review-time writes while retaining migration 058, protected reservations, owner reads, cancellation, export and erasure. Do not drop these tables or restore an older publication/ledger writer that bypasses their guards. Begun unresolved holds require a separately scoped resolution decision; disabling the feature is not a refund policy. No deployment is authorized by this guide.
