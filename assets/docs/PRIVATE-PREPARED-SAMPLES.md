# Prepared examples for private feedback

[#503](https://github.com/deepnative/deep-native-engine/issues/503) connects fixed invented examples to the existing private feedback browser journey. They are platform-provided, local synthetic and unreviewed, not member-authored work, qualified curriculum or a live safety scan.

## Create and review a copy

Run a dedicated local preview following [setup](workflows/VERIFICATION.md). Explicitly set `DNE_PREPARED_REVIEW_SAMPLES=enabled`; it defaults to disabled. Creation requires demo/test mode and an HTTP loopback origin. Never use a quality-gate database or server for a demo.

From **Manage private evidence**, select **Use a prepared invented sample**. Inspect any of the three exact versioned texts and its digest. The goal-based suggestion grants no role, allowance or completion. Separately check the provided-example acknowledgement and private-review permission, then create a private copy. Both controls start unchecked. The server supplies all bytes and source metadata; it accepts no arbitrary text, filename or existing source to promote.

Creation does not queue, assign, generate feedback or create test units. Return to the evidence page and explicitly queue the copy. Supply its visible ID/version to the administrator. A finite local administrator uses the [exact sample assignment form](PRIVATE-SAMPLE-ASSIGNMENTS.md), a reviewer's own reference and a finite window. The reviewer signs in normally, opens the assigned worklist, drafts exact-source quoted comments and explicitly publishes. The member reads them and can exchange one clarification and answer.

Only finite trusted staff identity provisioning is initial setup. This journey needs no hidden source, safety, queue or assignment fixture. See [staff entry](PRIVATE-LOCAL-STAFF-ENTRY.md), [feedback](PRIVATE-SAMPLE-FEEDBACK.md) and [worklist](PRIVATE-REVIEWER-WORKLIST.md). Optional review minutes remain a separate operation; copying creates or charges no units.

## Recover an uncertain save

A copy may already have committed when its result cannot be confirmed. Nothing is automatically repeated. **Inspect my original copy instruction** opens a separate tab, performs a current-owner read and preserves the original instruction in the first tab. Absence of a retained receipt does not prove that no write committed.

If deliberate repetition is appropriate, return to the first tab, check both acknowledgements again and choose **Repeat this original copy instruction**. The original operation identity and exact template remain. Concurrent submissions and a lost COMMIT acknowledgement retain at most one source. A changed template under that identity conflicts. Withdrawal or erasure does not recreate the source or revive permission.

Authority is fenced through database waits, COMMIT and response handback. Acquisition is bounded at 3 seconds, stages at 5 seconds and the transaction at 10 seconds. Uncertain database work discards its owned connection rather than enqueueing rollback or automatic repetition after an ambiguous commit.

## Retained provenance and erasure

Source and feedback pages retain the provided/invented/unreviewed label, version and digest. Changing goals preserves earlier origin. A separately edited revision stays pending with no inherited provided origin, clean state or review access; earlier feedback remains on its original source. Arbitrary uploads keep their existing quarantine requirements.

Downloads contain exact fixed bytes and provided-origin response headers. Evidence JSON `local-evidence-v3` retains applicable provenance within the existing 20-source/4 MiB limits. Download every page; these are live reads, not one frozen snapshot.

Structured records `local-member-records-v26` append `providedEvidenceOrigins` and `preparedCopyReceipts` at cursor positions 42 and 43. Positions 0–41 keep their meanings. The 100-record/256 KiB limits and owner-bound continuation remain. Exports omit original operation keys, storage keys, payload digests and credentials. Source deletion erases its origin; a content-free removed receipt may remain until normal workspace/account erasure. Existing consent withdrawal, exact grants and erasure still control access. Public/circle sharing remains off.

## Migration and creation rollback

Migration 070 is additive and repeatable. Legacy uploads keep their actual quarantine state and unknown provided origin. No clean status, consent, authorship, grants or inferred dates are backfilled.

Bytes come from an immutable versioned code manifest only when retained source/origin metadata match. No new per-member physical source file is written; uncertain creation never requires deleting possibly committed bytes. Generic upload storage stays separate. Retain referenced manifest versions while copies exist.

To pause creation, set `DNE_PREPARED_REVIEW_SAMPLES=disabled` and restart a compatible local runtime. Verify the choice is absent and creation denied. Existing owner inspection, provenance-aware read/export/download, feedback and deletion must remain available. Retain migration 070, manifest versions and the provenance-aware adapter. Do not drop tables or use an older binary that silently omits retained copies from export or cannot reconstruct their bytes. This procedure authorizes no deployment.

Parents #38/#39 remain open for broader criteria. This flow establishes no qualified review, funded service, live provider, public publication or full-MVP acceptance.
