# CTP-009 synthetic structured prerequisites

**Issue:** [#277](https://github.com/deepnative/deep-native-engine/issues/277), child of [#103](https://github.com/deepnative/deep-native-engine/issues/103). **Decision:** 26 September 2026, synthetic local preview only. Reviewed foundation content remains blocked by #93 and #97.

An editor may attach a JSON prerequisite contract to a synthetic lesson or assignment. The current contract is an all-of list with at most eight unique atoms:

```json
{
  "schemaVersion": 1,
  "all": [
    { "kind": "lesson", "id": "SYN-101", "version": 1, "activity": "started" },
    { "kind": "exercise", "id": "clear-instructions", "version": 1, "activity": "completed" }
  ]
}
```

Exact keys, a positive 32-bit version, and the listed activity names are required. A lesson reference must identify a current published curated synthetic lesson. References to missing, retired, superseded, self-referential or cyclic content fail closed at draft creation and are rechecked at approval and publication. Runtime eligibility checks the same member's observed activity against exact versions, including nested lesson requirements. Opening a lesson does not count as starting or self-assessing it. `clear-instructions@1` is the only named local exercise. Self-reported experience is a recommendation filter, not evidence that an activity happened.

Migration `026-structured-prerequisites.sql` adds nullable `structured_prerequisites` JSONB and shared PostgreSQL validation and eligibility functions. Existing rows remain unchanged. A structured value is authoritative and requires an empty legacy text field. A null structured value maps blank or case-insensitive `None` to no requirements, and the exact legacy `LOCAL-FIRST-EXERCISE-COMPLETE` token to observed local exercise completion; all other free text denies eligibility. Published content versions remain immutable. A newer released version keeps an older version superseded even if that newer version is later retired. Choices, attempt writes, lesson activity and private practice use the same database eligibility check; the read-side suggestion evaluator mirrors it. Private choice and attempt history retain their pinned versions when eligibility changes.

Rollback should first stop new structured authoring and preserve or export rows using the column. Reverting application code before converting those rows would make their requirements unreadable; dropping the column would destroy authored contracts. If a rollback is needed, keep the migration and move to a compatibility build that fails closed on structured rows, then make a separate deliberate data-conversion decision. No provider, qualified assessment, payment or live publication is introduced.

Verification maps browser journey L63 to owner observation, forged selection, outsider isolation and supersession on desktop and mobile. Unit and real PostgreSQL cases cover validation, legacy compatibility, self-reference/cycle, exact activity, attempt denial and retained history. The full `make verify` gate, pre-push hook, PR CI and main CI provide revision-specific evidence. This child does not close the reviewed-content scope of #103.
