# Prepare and complete ordinary practice assignments

The two version 2 assignments in the [reviewed pack](PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) offer invented signup checks and meeting-action practice. General learners, professionals outside IT and IT practitioners can use the meeting brief without coding. The signup brief suits the build goal and can also be completed as a written checklist. A job, paid plan or staff role is never required. The unchanged practice rubric is a self-check aid, not qualified assessment.

## Import and publish deliberately

A current editor opens **Content workflow**, confirms **Import the two reviewed assignments as drafts**, then chooses **Import two reviewed assignment drafts**. The importer checks both exact source hashes and writes both drafts together. It neither publishes nor changes version 1. A conflicting, partial, later or retired version refuses the whole import. A repeated intact import returns the existing versions. If the outcome is unconfirmed, inspect the current library before deliberately repeating; no automatic retry or overwrite occurs.

Publish the exact FND-002 and FND-003 version 2 preparation lessons through the [foundation workflow](REVIEWED-FOUNDATION.md). For each assignment, the editor chooses **Submit for review**; a distinct current reviewer checks sources and rights and chooses **Approve editorial review**. The editor then chooses **Publish reviewed assignment**. Missing preparation prevents approval/publication. These ordinary editorial actions do not establish professional credentials or a guaranteed reviewer service. Original version 1 drafts retain their existing hold.

## Follow the preparation and private work screens

On the learning page, **Prepare a future assignment** lists matching assignments whose prerequisites are not yet met. Open an assignment's checklist and follow each exact lesson link. Opening alone does not meet preparation. Start each lesson and explicitly report completion after reading. The checklist uses observed self-reported completion of FND-002 version 2 and FND-003 version 2; the source's equivalent-habit guidance does not automatically become a verified completion. Self-reported experience and completion are never proof of competence.

Once prepared, choose the assignment, open the private attempt, save an invented response, reload it and submit the saved version separately. Other members cannot read it. Submission retains the exact assignment and rubric version; a private submission does not itself assign a reviewer or publish the response. The separate #38/#545 intake journey supplies explicit reviewer access when enabled.

Changing goals or interests recalculates current choices. A published replacement or retired prerequisite can make an old assignment unavailable for new work; prior private drafts and submissions remain tied to their original version. The checklist shows unavailable preparation and a return link instead of treating a missing source as satisfied. Existing unknown/cyclic prerequisite rejection remains in the catalog and eligibility layers.

## Scope and evidence mapping

| Scenario | Executable behavior |
| --- | --- |
| ASN103-01 / L233 | Exact hashes, both drafts together, current editor authority, denied wrong role, preserved originals, repeat/conflict/rollback, separate source/rights review and publication |
| ASN103-02 / L234 | Three backgrounds follow exact preparation links, opening alone remains insufficient, private noncoding response save/reload/submission and another-member denial |
| ASN103-03 / L235 | Current goals and retired preparation update choices; previous exact work remains private and readable with a useful next action |

Unit cases cover the loader, shared bounded importer, HTTP denial/recovery and ordinary labels. Native cases are in `tests/integration/reviewed-assignments.test.ts`, alongside unchanged foundation authority/expiry/lock/commit-acknowledgement cases. Browser cases in `tests/e2e/reviewed-assignments.spec.ts` use real runtimes, separate temporary databases and normal member/editor/reviewer screens on desktop and narrow devices. The shared fixture preserves the foundation journeys and drains only its own database connections before cleanup.

The repository's complete verification, pre-push hook, current head and merge-candidate CI, guarded merge, resulting-main verification and dedicated product demonstration remain required. This outcome depends on #93 source content and #117 foundation reading/publication. It does not enable a live provider, payment, public sharing, qualified review or full-MVP acceptance, and it does not change Tom's contribution or private feedback delivery.
