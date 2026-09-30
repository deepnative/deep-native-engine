# CTP-008: exact starter practice after a goal change

**Issue:** [#401](https://github.com/deepnative/deep-native-engine/issues/401), child of [CTP-008 #28](https://github.com/deepnative/deep-native-engine/issues/28)
**Prepared:** 30 September 2026
**Scope:** local synthetic preview only

## Problem and decision

The starter lesson has one saved exercise slot per learner and content version. A completed or withdrawn exercise cannot be overwritten. That correctly protects earlier work, but a learner who changes direction cannot practise the same starter lesson for the new goal. Replacing or resetting the old row would lose evidence and withdrawal history.

The approved child scope adds one slot per learner, lesson, version and **recorded goal**. A goal change alone does not create an exercise. The learner may complete a new slot for the current goal, then return to the exact earlier slot without changing its original goal, answers, completion time or withdrawal state. There are still no unlimited retries. Historical rows with no recorded goal remain explicitly *unattributed*; migration must not infer a goal from today's profile.

The stored goal is a practice identity, not an entitlement, staff role, assessment or content-approval signal. Existing named lesson/version prerequisites continue to mean that any retained completion for that version can satisfy the prerequisite. The current starter plan, however, reflects practice for the member's **current** goal, so a completed A and missing B displays B as unfinished.

## Data, privacy and failure boundaries

- Migration preserves every pre-existing exercise's text, goal value or null, completion timestamp and withdrawal marker. A database constraint prevents duplicate slots for the same recorded goal. Account deletion removes all slots and markers.
- History, read and withdrawal links identify one exact retained slot. Unqualified old links may resolve only when unambiguous; an ambiguous request must fail closed rather than choosing a first row.
- Export pagination distinguishes same-version goal slots and rejects obsolete cursors with a restart instruction. Withdrawal removes answer text from later reads and exports while preserving truthful, content-free completion metadata.
- A form carries its original goal. Saving checks it against the current profile in the same transaction, using a common lock order for profile updates, practice writes, withdrawal and deletion. A stale form cannot be silently reattributed to a new goal. Duplicate or concurrent writes cannot replace a completed or withdrawn slot.
- Another member's slot, a forged record identifier and an expired or revoked session cannot read, change, withdraw or export private practice. Recovery after an uncertain write identifies the exact goal slot and never repeats withdrawn text.

This is a local PostgreSQL preview using invented information. It does not add a live AI provider, qualified feedback, production identity, approved access terms, paid coaching, sharing or deployment. Those parent acceptance areas remain open in #28 and their linked decision issues.

## Verification and rollback

First reproduce completed A → switch to B → attempt B practice against the previous single-slot behavior. Then test saved/reloaded B, return to A, exact history and withdrawal, a same-version export page boundary, legacy-null migration, other-member denial, stale forms, concurrent first writes and profile changes, and unchanged prerequisites. Exercise general, non-IT professional and IT paths in the approved desktop/mobile browser matrix. Record new scenario IDs without removing existing obligations.

Do not roll the database back to code that assumes one row per lesson/version after multiple goal slots exist. That code could read an arbitrary row or fail to preserve a withdrawal marker. Prefer a coordinated forward repair. If a code rollback is unavoidable, first preserve every distinct row and marker in a verified backup, stop writes, and use a reviewed migration that can restore the new schema without collapsing records. Never drop extra slots merely to make old code run.

Completion requires the exact-commit `make verify` gate, unbypassed pre-push verification, review, PR CI and CI on the resulting `main` commit. The local-slice result must stay separate from outstanding full-MVP journeys and launch decisions.
