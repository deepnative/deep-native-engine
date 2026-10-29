# Guided first lesson — #548

This bounded change teaches the first request-writing lesson through an original worked example, an attempt with answer-specific correction, a different transfer question and the existing private writing exercise. Everyday, workplace and technical goals each have their own material. It follows the owner's 27 October learning-quality direction and the bounded [live issue](https://github.com/deepnative/deep-native-engine/issues/548).

Codex `/root`, claim `DNE-2026-10-27-548-guided-first-lesson-root`, owns `codex/548-guided-first-lesson` in the isolated worktree of that name. Recommendation: Sol/High for delivery and author design/review; Astra/High if a separate authority review is required. No independent review is claimed.

## Teaching and data boundaries

- The [Khan Academy study](https://blog.khanacademy.org/meet-the-new-khan-academy-classroom-experience/) informed clear next steps, practice and useful feedback. The [Duolingo method](https://blog.duolingo.com/duolingo-teaching-method/) informed short attempts, hints and applying an idea to a new context. Examples, explanations and interface assets here are original.
- Guidance version 1 is independent of the unchanged starter lesson version. A stale goal or version restarts clearly. This change introduces no migration, provider, credential, new persistence or paid service.
- Fixed-choice checks do not save a personal answer, overwrite a draft, complete an exercise or establish mastery. Only the existing deliberate exercise actions save or complete work. Earlier versions, owner isolation, withdrawal, export and deletion remain in the existing implementation.
- New routes are behind the existing current-member, same-origin and CSRF checks. Unknown choices/fields and missing bodies are rejected. CSRF may arrive in a header, so an authenticated empty body is explicitly handled.

## Behavioral evidence

Baseline: `1d7ee412f784a9b8546ad3f0b68cdc6599a19c8e`. On 27 October 2026, the first new behavioral test expected the guided entry to return 200 and observed 404. Its first green is preserved separately. Existing saving was not presented as newly failing behavior.

| Acceptance / scenarios | Executable evidence and observed outcome |
| --- | --- |
| AC1–2 / GUIDE-01 | `starter-guidance-http.test.ts` and L242–244 open the normal lesson entry and each matching original worked comparison. |
| AC3 / GUIDE-02–03 | HTTP checks cover all 18 choices across six questions, their explanations, hints and deliberate correction. L242–244 follow an incorrect attempt, hint, correction and distinct transfer case. |
| AC4 / GUIDE-04 | Five real PostgreSQL tests preserve drafts/completion, reject a foreign member selector and keep private work isolated. Browser journeys return to the identical draft before deliberately completing it. |
| AC5 / GUIDE-05–06 | HTTP tests cover malformed input, valid-CSRF empty body, unknown choice, query fields, forged CSRF/origin, expired access and stale goal/version. Native tests cover actual revoked/deleted accounts and a goal change. Browsers submit a stale form after changing direction in a second tab and retain the earlier completed work. |
| AC6 / GUIDE-07 | L242–244 pass on desktop and Pixel 7 Chromium, including Back/reload, normal controls and no horizontal overflow. Actual desktop example and mobile correction screenshots were visually inspected. |

Focused evidence root: `/Users/tomwu/Documents/Codex/2026-10-27/dne-guided-first-lesson/`. Environment: macOS, pinned Node 24.21.0, Python 3.14 and the coordinator-owned durable PostgreSQL 18 service. Focused integration and browser runs created distinct generated databases, closed their connections and confirmed removal without force or changing durability. Browser servers used random ports, separate from the frozen release gate on 4317.

- Full unit suite: **4539/4539 passed**, no skipped tests; all 182 modules pass the existing per-file 99% thresholds. Global raw coverage: statements 13125/13133 (99.93%), branches 12777/12808 (99.75%), functions 2838/2839 (99.96%), lines 11966/11972 (99.94%). Raw per-module counts are in `full-unit-reviewed-coverage.json`; all three new modules are 100%.
- Feature HTTP tests: **18/18 passed**. Native integration: **5/5 passed**, confirmed owned database cleanup. Browser journeys: **6/6 passed**, no skips/flaky results/retries, confirmed owned database cleanup.
- Register `initial-learning-v116`: 235 approved scenarios/234 critical. The prior 232 objects and all 27 full-MVP objects are unchanged. Six focused executions do not claim the complete 235-scenario matrix has run.
- Preserved review correction: an initial coverage failure exposed an unexercised empty-body branch. Removing it was rejected in self-review because header-based CSRF allows an empty request to reach this route. The regression reproduced 503 instead of 422, then passed with the defensive handling restored. Thresholds and assertions were not reduced.
- Author review found no remaining blocking issue in teaching content, ownership, existing completion meaning or error recovery. The workplace success heading was corrected so selecting an unsupported commitment does not label that commitment a supported fact.

## Delivery and demonstration boundary

These are local implementation and focused acceptance results. The complete exact `make verify`, ordinary push hook, current PR CI, guarded merge, resulting-main CI and hosted demonstration for #548 remain pending. The separate account/support release is frozen at 1d7ee41 while its own gate runs; this work does not change that checkout or claim its verification.

Use the existing `npm run preview` launcher with the owned PostgreSQL control URL to build a fresh runtime and database. Open its printed loopback address, choose a goal, open the first lesson and choose **Start with a guided example**. Continue through correction and transfer, then save the writing exercise. The launcher retains restart/shutdown instructions and private fixture metadata; never include staff credentials in screenshots or public evidence. Its invented-data demonstration does not establish a hosted deployment or qualified curriculum approval.

Next bounded action: finish this issue's serialized full delivery after the already active account/support release. Sol/High is recommended; preserve the other coordinator's #93/#117/#103/#114 claims. Parent #34 remains open for its broader provider, grounding and human-service requirements.
