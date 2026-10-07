# Private workflow review in the local preview

A member can offer one exact saved workflow note for finite private reading. This is not qualified assessment, a staff response promise or permission to publish the note. No AI provider receives it.

## Member → administrator → moderator

1. Save an invented note on a workflow version. Select **Request private review of this exact note**, read the exact revision and fixed deadline, then deliberately confirm. Saving a note alone never shares it.
2. A moderator signs in through local staff entry and obtains their own noncredential review reference. The member supplies their request receipt to the local administrator.
3. The administrator checks those exact references and the UTC reading window, then confirms the assignment. Administrator screens contain metadata, not the private note.
4. The assigned moderator opens **My assigned private workflow reviews** and reads the exact note while all required authority remains current. A moderator role alone gives no access.
5. The member can withdraw review permission while keeping their own note. Editing or deleting the note invalidates earlier access. Recreating even identical text needs a fresh deliberate request and assignment. An administrator can revoke one exact grant.

## Unconfirmed writes

A request or assignment can commit even if its response is lost. Keep the original recovery page and key. Inspect the original operation in its separate receipt tab before choosing any deliberate exact repeat. The receipt tab has no opener and the original unchecked repeat form stays available. A repeat keeps the original receipt and deadline; it does not create another permission or extend authority. An unavailable inspection is not proof that nothing committed. Never replace the key to work around an uncertain result.

## History and privacy

Own request receipts/history and member export contain bounded metadata. Staff attribution in export is generic; no staff directory or second raw-note copy is retained in permission history. Download every available export page for your records. Member erasure removes private note/request/grant linkage; anonymous reserved operation keys remain to prevent reuse.

## Configuration and compatible pause

New creation defaults off. In the local test/demo configuration, enable `DNE_LOCAL_STAFF_ENTRY=enabled` and `DNE_WORKFLOW_REVIEW_REQUESTS=enabled`, then restart the current application. Existing finite staff credentials must be separately configured; enabling the interface does not provision staff or grants. Live mode rejects this local capability.

To pause new creation, set `DNE_WORKFLOW_REVIEW_REQUESTS=disabled` and restart the **current** application against its existing database. Member notes/history/export/erasure, permission withdrawal, exact grant revocation, currently permitted reading and original-operation inspection remain available. New preview and assignment creation are unavailable. Keep additive migrations 064/065 and stored history; no destructive downgrade or older-binary compatibility is promised.

## Scope and evidence

Delivery issue [#489](https://github.com/deepnative/deep-native-engine/issues/489) tracks the executable WFREV-01–08 acceptance evidence, original failures, delivery revision and dedicated demo. Parent [#115](https://github.com/deepnative/deep-native-engine/issues/115) remains broader: staff responses, qualified review, contribution rights, publication and full-MVP acceptance are not established by private reading. This branch guide does not claim merge, deployment or commercial availability.

## Acceptance map for delivery #489

The live issue carries results, original failures, exact delivery revision and CI closeout. The table names executable evidence, not qualified approval. Focused results do not replace the complete gate.

| AC / BDD scenario | Executable evidence | Browser journey |
| --- | --- | --- |
| WFREV-01 exact deliberate member request | `workflow-review-http.test.ts`, member domain/packet/route unit suites | L192–L194: ordinary three-audience onboarding, own note, unchecked exact preview and confirmation |
| WFREV-02 finite metadata-only administrator assignment | `workflow-review-staff-http.test.ts`, `workflow-review-window.test.ts`, staff domain/routes and packet units | L192–L194: actual sign-in, moderator reference, canonical UTC check and deliberate assignment |
| WFREV-03 exact current moderator read and foreign denial | staff HTTP, worklist units and `workflow-review-race.test.ts` | L192–L194: own worklist/detail, other moderator and learner denial |
| WFREV-04 withdrawal, correction and immutable recreation | `workflow-review-source.test.ts`, observed read races, history/export tests and member/staff domain units | L192–L194: retain owner note, deny old grants after correction and identical recreation, explicitly assign recreated source |
| WFREV-05 finite authority through acquisition/query/render/commit/native release | `workflow-review-expiry.test.ts`, `workflow-review-race.test.ts`, transaction and render/route units | L192–L194: exact grant revocation and retained owner note; database/render lifetime evidence remains separate |
| WFREV-06 observed contention and genuine committed lost reply | `workflow-review-write-race.test.ts`, `workflow-review-recovery.test.ts`, operation/transaction units | L195–L196: actual COMMIT/lost reply, inspect separate receipt, original-key deliberate repeat and canonical reload |
| WFREV-07 bounded owner history/export and erasure | `workflow-review-history.test.ts`, `workflow-review-export.test.ts`, appended member-export unit cases | L192–L194: owner metadata/history and actual downloaded page; multi-page and anonymized erasure are proved with PostgreSQL |
| WFREV-08 safe forms, host/origin/CSRF, default/live denial, populated migration and pause | member/staff routes/config/view units, HTTP tests, `workflow-review-migration.test.ts` | L192–L194: narrow screen, keyboard confirmation, escaped invented text and current-runtime creation pause |

Stable approved local IDs are appended to the existing register; all earlier IDs and full-MVP requirements remain present. Unit coverage includes all new first-party modules and has no new exclusion. Original failing behavior, setup errors, assertion corrections and cleanup failures are retained separately on the issue; corrected passing runs are never called original first-attempt clean.

The source UUID is backfilled once by migration064 and immutable thereafter. Migration065 adds reference-only requests/grants and globally reserved actor/instruction-bound operation keys. Member and staff transactions discover locators without authorizing, lock sorted complete principals then staff profiles, owned workspace, exact source, request, grant and operation reservation as applicable, and revalidate before selecting private text. Database-derived expiry is converted to a monotonic limit and rechecked through render and native handback. A completed read cannot recall an earlier staff capture; revocation denies subsequent protected reading.

A member export contains no copied note in permission metadata, staff IDs or operation key directory. Erasure removes active private relationships and leaves only anonymized immutable reserved operation keys. Current-runtime pause preserves these privacy and recovery paths; it is not a schema downgrade. No provider, package or external data integration is added.
