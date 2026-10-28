# Ordinary reviewed workflow examples

Issue #114 serves the three immutable version 2 workflow files prepared under [#93](https://github.com/deepnative/deep-native-engine/issues/93) from the existing `/workflows` reader. The current owner direction permits ordinary educational content after factual, source, rights and declared-environment checks. This is editorial review by Codex, not human expert qualification, accreditation, formal assessment or approval of a live model or client system. The issue records actual verification, merge and demonstration status; this guide alone establishes none of those outcomes.

## Member journey

Open `/workflows`, search by title, goal or background, then choose a version. Each entry shows prerequisites, setup, supported environment, permissions, costs, source, rights, accountable owner, editorial reviewer, verification and next-review dates. General learners, professionals and IT practitioners can use the text without staff access, a paid plan or coding. Downloading Markdown or copying the readonly exercise text performs no execution or provider call.

The available examples are:

| Version | Manual exercise | Recorded check and boundary |
| --- | --- | --- |
| WF-001 v2 | Turn an invented sign-up brief into requirements | Compare the two stated requirements with the brief. Keep contact/privacy/access questions open; do not invent a planning-screen requirement. |
| WF-002 v2 | Review a hand-authored candidate test suite | Distinguish missing coverage, account-disclosure risk and unsupported password policy. The example does not execute software tests. |
| WF-003 v2 | Extract actions from invented meeting notes | Preserve Sam's draft, Alex's later feedback, and unknown trial lead/date/announcement owner. Do not infer calendar dates or send a message. |

The [27 October editorial record](PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) and [reviewed pack index](PLAN-004-CONTENT-PACK.md) contain source and asset-level review evidence. The recorded owner is the Deep Native Engine delivery team with Tom Wu as interim curriculum owner. The recorded reviewer is Codex root under the #93 claim. Manual input/output comparison occurred on 27 October; the declared next review is 27 November or sooner when source requirements or the supported environment change. These dates do not establish a scheduled human service or any external compatibility test.

The rights statement remains **“No new license granted; repository-authored educational examples, with third-party and member rights separate.”** Application availability does not create a third-party license or redistribution permission. No original version 1 or reviewed version 2 asset is rewritten. The downloaded editorial metadata is an immutable preparation record; its statement that application import/publication had not yet occurred describes that record's preparation state, while the deployed reader determines current availability.

## Version and maintenance rules

Curated workflows remain file-first. A reviewed source release explicitly selects the three known files under `content/reviewed-v2/workflows`; learner proposals use their separate consent and moderation lifecycle. No proposal automatically becomes a curated workflow, and no database import or migration is needed for these three files.

A future maintenance release must retain the old asset and add the next immutable version with a dated source/rights/editorial review, declared manual or actually verified environment, owner, limits and next-review date. Change the explicit registry selection through the normal issue, self-review, complete verification and guarded-merge workflow. Update each current-version compatibility fixture while retaining historical rows, stale-version rejection, privacy and race assertions. If technical execution has not occurred, say so rather than presenting a manual comparison as an execution test.

An explicitly retired registry entry (`publication_state: retired`), invalid source metadata or empty body is unavailable and never falls back to an old draft. Remove or retire availability only through an owned reviewed release. Existing private feedback remains owned historical data and can be withdrawn; retiring availability does not erase it. The existing exact-version route returns 409 for a replaced version and 404 for an unknown/unavailable entry, without returning newer body bytes or an attachment. The member deliberately chooses “Browse current workflows” to recover. Missing or malformed download versions retain the existing denial contract.

Private notes and private improvement proposals retain their exact workflow versions. A retained version 1 note is not copied into version 2, cannot be edited as current version 2, and does not silently acquire a new review permission. Saving a fresh version 2 note leaves version 1 intact. Own export identifies both; exact historical withdrawal removes only that old note. Existing current authorization, independent private review permission and assignment, revision checks, withdrawal, erasure and export controls remain unchanged.

## Acceptance and evidence

| Scenario | Executable evidence | Meaning |
| --- | --- | --- |
| WFR114-01 | `tests/unit/workflow-registry.test.ts`, L236–L238 | Reviewed version 2 and factual metadata are selected; invalid and retired entries fail closed. |
| WFR114-02 | Existing L41 and L236–L238 | Search, readonly text, exact inert Markdown bytes and manual-only boundaries work across member backgrounds and desktop/narrow screens. |
| WFR114-03 | Registry HTTP/unit cases, `tests/integration/workflow-feedback.test.ts`, L236–L238 | Stale versions disclose no replacement body; retained private history remains separate, exportable and withdrawable with other-member denial. |
| Existing privacy/recovery contracts | Workflow feedback, review, proposal and export suites | Revision numbers, finite consent/assignment, database lifetime/race tests and original recovery checks are preserved while current workflow fixtures move to version 2. |

L41 and every prior registered journey remain in the approved denominator. L236–L238 add the three distinct background/history paths; full-MVP requirements remain separate and unaccepted. Focused results never substitute for exact clean-commit verification, the full pre-push hook, current head/merge-candidate CI, resulting-main CI and an actual dedicated invented-data demonstration. Read the live issue for original failures and final evidence.

For a local demonstration after verified delivery, run `make preview` in a dedicated checkout, use its printed address, and open `/workflows`. Read an example, inspect its versioned download, and start a separate invented member to save and reload a private note. Use a separately seeded historical fixture only when demonstrating the upgrade path; do not modify an active verification database or a real member record. Stop that preview with Ctrl+C. Hosted availability must be read back from the actual deployed version rather than inferred from a local pass.
