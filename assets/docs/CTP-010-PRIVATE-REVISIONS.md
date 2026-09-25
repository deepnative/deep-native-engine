# Private synthetic evidence revisions

This bounded CTP-010 #38 prerequisite lets a member create a new invented text object from their own clean, submitted, consented evidence. It does not provide a qualified reviewer, criterion feedback, an appeal, funded review time, or formal assessment.

## Lineage and authorization

- Migration 024 adds a nullable parent ID and an immutable revision number to each evidence object. Existing objects are version 1. A parent may have at most one current direct revision, and the chain is capped at version 20.
- The upload transaction locks the member's workspace, checks that the parent belongs to that workspace and owner, is clean, still allows private review, has a queued or reviewed submission, has no later revision, and is below the cap. Cross-member, stale, revoked, deleted and duplicate attempts return without writing bytes. The unique parent index is a second race guard.
- The new revision receives a fresh object ID, storage key, rights attestation, private-review consent and pending quarantine state. It is not submitted automatically. Reviewer grants remain bound to the exact original submission; no grant is copied to a revision.
- The member evidence page shows version and parent identity. The revise form retains entered text after validation or a stale-write response. It offers the action only for eligible text, and the store repeats every check.

## Deletion and export

Deleting an original object removes its configured active source, derivatives and submission through the existing deletion path. PostgreSQL clears the surviving child's parent link, retaining its version number and bytes until the member separately deletes that child. Deleting the entire workspace removes every object. The local evidence JSON export includes each current object's revision number and current parent link; its existing size and safety limits still apply. A removed ancestor is not represented as a retained record.

This is a local synthetic preview with no live scanner or provider. First-attempt desktop/mobile `F-BUILD-02-A` is provisional browser evidence against the compiled app and isolated PostgreSQL; the approved 100-case full-MVP register and release gate remain separate. Qualified review, pinned feedback, revision appeals and production retention decisions remain open under #38 and #94.
