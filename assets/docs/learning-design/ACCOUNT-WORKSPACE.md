# Account learning workspace — #34

Implementation evidence on 29 October 2026: application wiring and migration registration are implemented on `codex/34-account-learning`. Before program integration, the six registered member/editorial journeys passed all 12 desktop/mobile executions against the actual runtime and PostgreSQL, with no retries, skips or unexpected errors. The combined program/workspace revision `e4cbda3c9f93f4dfd5823af3b32036f98fd1c5be` subsequently passed the same complete 12-case browser file on Linux with real PostgreSQL, both original projects, no retries, skips, unexpected results or global errors. Exact-commit delivery and hosted status are recorded on [live issue #34](https://github.com/deepnative/deep-native-engine/issues/34); these component results do not establish merged, hosted or full-MVP behavior. Production remains parked.

## Member journey

The account workspace reuses the six authored lessons, Everyday/Work/Technical examples, three applied cases, feedback practice and contribution drafting from the local reader. Learn exposes the path, Practice revisits checked mistakes, and My work returns to retained writing. Activity is not a grade or credential. Free writing and self-checks are not automatically assessed. Initial examples follow the member's goal; switching examples never grants a staff role or paid plan.

`Save my work` captures the current notebook explicitly. Navigation and typing do not save. The account adapter stores the exact lesson version and example route under the authenticated member. A separate browser can restore the notebook with the same authenticated account. Existing standalone browser notebooks remain separate; opening the account application does not import or erase them.

Earlier lessons, starter work and assignments remain available through `/learn/records` (the existing `/learn?view=records` dashboard). `/account`, `/my-courses`, `/support` and `/member/export` remain ordinary account destinations. The separate local program has its own exact FND v2 activity; saving the LRN-001 v1 notebook does not mark a foundation lesson complete. The standalone request/check walkthrough stays in the local reader; account lesson navigation points to the actual earlier lessons and assignments.

## Saving and recovery

- A fixed draft keeps all 27 existing writing fields, up to 30,000 UTF-16 units each, together with bounded practice/navigation state. The draft endpoint accepts up to 8 MiB of JSON; it never silently truncates writing.
- Accepted feedback decisions form separate append-only history. The fixed draft records the decision head it was based on. Saving history does not silently label a different draft saved.
- Each mutation carries an operation UUID and expected revision. Replaying the same payload confirms its original receipt; changed reuse or stale revisions conflict.
- If a response is lost, the page keeps current writing and reports an uncertain outcome. Explicit inspection checks the original operation before a retry. Confirmed earlier writing does not clear newer unsaved edits.
- Downloads preserve exact accepted strings, including control characters and lone surrogates. When saved history cannot be fetched, a clearly labelled local rescue download retains current writing and identifies incomplete history.

`/learn/notebooks` exposes owner-only retained copies independently of teaching-source availability. Each notebook has its saved draft, feedback-history pages and JSON downloads. History pages contain at most 20 decisions; follow the next link to collect the remaining history. Each continuation checks the original bearer again. A page is a current read, not a frozen whole-account snapshot.

The saved draft's baseline and the current feedback head are labelled separately. HTML displays nonrenderable characters using visible `\uXXXX` notation; JSON contains the exact saved values. Removing a notebook requires explicit confirmation and its current revision. An uncertain removal leads to a read-only status check; a matching receipt and deleted notebook confirm removal. Previously downloaded copies are outside this operation.

## Teaching and editorial workflow

The workspace uses its own registered `LRN-001` version 1 bundle. It does not masquerade as canonical FND v2 lessons or satisfy existing ASN assignment prerequisites. The private JSON bundle is generated alongside the standalone course module by `reader/build.py`; `--check` verifies source parity. Exact instructional and file hashes are pinned in `src/learning-workspace-pack.ts`.

A current editor explicitly imports a draft through `/editor/library/learning-workspace`. Editors and reviewers inspect the complete bundle, including all examples, questions, explanations, capstones and supplied feedback. Ordinary submission, separate reviewer rights confirmation and publication follow. Importing is not publication, startup does not import automatically, and no qualified assessment is claimed. An unconfirmed import response links to inspect current state before another attempt.

Teaching module delivery requires current member eligibility and exact published-source agreement. Unpublished, replaced or retired sources cannot start new work or accept new writing. Permitted old writing/history/export remain available; missing teaching files do not erase saved writing. Account/workspace deletion removes owned records. Explicit notebook removal erases its writing/history while retaining text-free receipts needed to prevent stale resurrection.

## BDD and verification boundary

The stable LWORK meanings are recorded in the [live #34 claim](https://github.com/deepnative/deep-native-engine/issues/34#issuecomment-6498265666). Gherkin and prepared tests are specifications until executed.

| Scenario | Outcome | Executable coverage |
| --- | --- | --- |
| LWORK-01 | Useful account Learn/Practice/My work entry; earlier learning reachable | Pages/reader unit tests; application browser L258–260 |
| LWORK-02 | Six lessons and three routes retain source, checked correction and fresh application | Reader rendering/account tests and authored checks across the full course; representative application browser L258–260 |
| LWORK-03 | Exact explicit save, another authenticated browser, variant/member isolation | Store, adapter, real HTTP/PostgreSQL tests; application browser L258–260 |
| LWORK-04 | Conflict and uncertain outcomes preserve writing and inspect before retry | Adapter and real HTTP/PostgreSQL tests; committed-response-loss browser L262 |
| LWORK-05 | Exact editorial source, retirement, retained history/export | Publication, assets, records and export tests; editorial/retirement browser L257/L261 |
| LWORK-06 | Original authority, expiry/revocation/deletion and concurrent operations | Real PostgreSQL lifetime, export and records tests; browser member isolation L258–260 covers only that subset |
| LWORK-07 | Existing standalone notebooks and earlier account work preserved | Browser adapter/local entry tests and existing standalone checks; earlier account records in L261 |
| LWORK-08 | Actual account navigation and desktop/mobile reader | Component visual review with invented stubs; actual application browser L258–260 |
| LWORK-INTEGRATION-01 | Given a signed-in member and separately published program/workspace sources, when the member deliberately enrolls through My courses, saves private notebook work and later reports completion of one exact foundation lesson, then the same account retains both records and notebook work alone does not create foundation completion | Missing-link RED and fixed-link GREEN in `tests/unit/learning-workspace-views.test.ts`; combined PostgreSQL-backed browser L258–260 passed on desktop and mobile at `e4cbda3` |

The original missing-entry RED ran against the real application on clean `20e6d36`: onboarding reached `/learn`, which had no Practice navigation. Focused evidence is retained outside the repository under `/Users/tomwu/Documents/Codex/2026-10-29/dne-34-learning-workspace/`. Component results include 15 persistence/publication, seven export, six adapter/HTTP/PostgreSQL and four retained-record PostgreSQL cases. New page/assets/records/view checks pass 21 unit tests at 100% in their scoped run; reader tests pass 121 with every shipping reader module meeting 99%. These separate runs are not a complete gate or a checked final commit.

The export deletion race, fresh-notebook revision, incomplete-history rescue and uncertain-retry findings were corrected and separately reviewed. The account prototype-link defect has a retained failing test and subsequent passing reader run. Component visual review covered desktop and mobile; its stores were invented stubs, not the main application. The mobile recovery action wrapping and unconfirmed HTML import response were corrected and recaptured.

## Delivery status

The owner explicitly authorized the isolated shared-file additions and later reconciliation with PR #558. Store construction, migration 080, route mounting and editorial/earlier-learning navigation are now wired; focused fixtures use the ordinary migration entry point. Preserve #558's program enrollment and migration 079 during reconciliation.

The pre-integration register v121 retained all 253 prior journey objects and added L257–262; that original browser run passed 12/12 with stable source hashes, zero unexpected/flaky/skipped results and zero global errors. The combined register v123 preserves L254–256 from PR #558 plus L257–262: 262 planned journeys, 261 critical journeys and 524 primary executions. Those are specifications until the combined gate runs. The new navigation test first failed because `/my-courses` was missing, then passed after adding the link. All 12 combined browser executions passed in the first run, including enrollment, unchanged FND progress after notebook save, and exact FND-001 v2 self-assessed completion. The original reports and ordinary database-cleanup evidence are linked from the live issue; this is component evidence, not a full gate. The earlier authenticated browser used the same invented account cookie; it did not claim a real email receipt. Earlier full unit coverage passed 4,991 tests before program integration; the original coverage failure and subsequent correction are retained.

Delivery requires the complete exact-commit unit/type/lint/PostgreSQL/browser/build/audit gate, normal pre-push hook, current PR CI, guarded merge, resulting-main verification, dedicated invented-data demonstration and safe cleanup. Broad #34 retains its unmet live-provider, budget and human-service scope. Lead recommendation: Sol/High; authorization/privacy review: Astra/High. No payment, provider or deployment is enabled by this slice.
