# Private sample feedback

Issue [#450](https://github.com/deepnative/deep-native-engine/issues/450) advances parent #38 with a private, invented-data learning loop. No qualified rubric, score, paid service, booking, automatic routing or notification is provided.

## Use the local preview

Run the normal local application with a dedicated preview database and private object-storage directory. A member creates an invented text sample under **Manage private evidence**, explicitly confirms rights and private-review consent, and queues it after a separately performed synthetic safety transition. Uploading does not certify safety or qualification.

A trusted local operator separately provisions a reviewer session and a current reviewer workspace assignment through the existing authorization store. Grant that reviewer the exact submission with purpose `private_sample_feedback_v1` through `grantEvidenceReview`. Existing arbitrary purpose strings do not grant publication authority. Staff tokens belong in private credential files, never in URLs, screenshots or repository files. Member background grants no staff privilege.

The reviewer opens `/review/evidence/<evidence-id>/feedback`. Save one to five criteria, each with a label, comment and exact quote from the displayed source. Choose the quote occurrence when text repeats. Labels allow 100 characters; comments and quotes allow 1000. Optional preparation/review minutes are integers from 0 through 480 and are self-reported, unbilled observations. The draft is private to its author. Explicit publication uses the saved version; unsaved form edits are not published.

The member follows **Read private feedback** from their evidence list. Published comments remain immutable. While consent remains active, the owner can ask one clarification and the same currently authorized reviewer can answer once; each allows 2000 characters. A revision creates a separate source requiring its own safety check, consent, queue and exact grant. Earlier feedback stays attached to its original source.

Withdrawal stops reviewer access and new exchanges, while the owner retains published feedback. Reviewed status remains historical; it does not imply current consent. Deleting the source, workspace or account cascades the feedback and draft-operation records. Bounded member export v19 includes published feedback and clarification/answer, excludes drafts and replay identities, and preserves existing cursor section indices.

## Failure recovery and boundaries

A stale or rejected write shows submitted text for copying. An uncertain write may already have committed: inspect saved state before deciding on another action. There is no automatic replay. Publication and operation identities distinguish exact repeats from conflicting submissions. Without an explicit review-time allocation, no allowance or ledger charge is created. Optional [review test-minute settlement](PRIVATE-REVIEW-TEST-MINUTES.md) uses a separate allocation-specific permission and actual intervals; existing unbilled observations are never converted or backfilled. Neither flow establishes qualified review.

References use UTF-16 code-unit offsets and exact source text; surrogate pairs cannot be split. Stored source length and SHA-256 are checked before display or mutation. Source reads are limited to 1 MiB. Owner feedback pages contain at most 20 records; member export retains its existing 100-record and byte bounds.

## Transaction and migration operations

Migration 056 is additive and repeatable. It adds constrained feedback, a draft-operation digest journal and metadata-only audit records, plus immutability triggers. Schema/trigger changes take normal PostgreSQL migration locks. Existing sources, consent and grants are not rewritten.

The transaction locks current principal, workspace, source, submission, workspace assignment and exact grant before feedback. Reads use shared source locks; writes acquire the source update lock immediately to avoid upgrades. Export locks source parents before feedback rows. Deletion/withdrawal winning the source fence denies later work; a completed operation winning first leaves its historical effect before deletion/withdrawal proceeds. Repeatable-read export may report unavailable after a conflicting deletion rather than mix snapshots.

Acquisition is bounded at 3 seconds, each stage at 5 seconds and the whole operation at 10 seconds. Validated database remaining authority is also enforced with monotonic elapsed time through COMMIT and connection handback. An unknown query or commit discards the owned connection without queued rollback or replay. Audit records carry identifiers/actions, never raw source or comment text.

Rollback after data exists must disable new feedback routes and writes while retaining schema, published records and compatible owner read/export/deletion behavior. Do not revert to an older binary that silently omits retained feedback from export. Do not drop tables, re-enable withdrawn consent or repurpose legacy grants. This procedure authorizes no live deployment.

Exact source text preserves its stored whitespace and line breaks while wrapping long lines for narrow screens. This visual wrapping does not alter stored source offsets, quoted references or downloaded content.
