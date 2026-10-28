# AI, put to practice — complete local foundation reader

This reader makes all six authored lessons and the connected final practice usable in Everyday, Work and Technical routes. It is a local learning experiment under [#549](https://github.com/deepnative/deep-native-engine/issues/549), separate from the shared application reader owned in #117.

Choose a route, then follow **example → try → fresh case → your work**. Practice choices and claim classifications have hints and source-based explanations. Incorrect answers invite revision; correct responses lead to a fresh case. Questions include the drafts or schedules they ask the learner to inspect. The reference panel follows the fresh exercise's source. During later own-work stages, it shows the learner's Lesson 1 notes as **Your starting work**, with an instruction to check the original source; without those notes it offers a labelled example. The final practice uses its own fresh brief and six writing fields.

Opening a page is not completion. The path distinguishes written notes and a deliberate learner self-check. Editing fresh writing, lesson work or the final record clears the applicable previous self-check. Free writing has authored criteria and comparisons, not an automatic grade. Comparisons are supplied examples rather than responses generated from the learner's text.

Lesson 6's **Fresh case** now includes a [feedback decision workspace](feedback-workflow.md). Learners can revise, decline with a reason or record an already-addressed change while preserving draft/comment versions. Decisions and unfinished responses use the same explicit notebook save and export. A clarification stays in the notebook; it is not sent to a reviewer.

## Run locally

Use the already running dedicated content-preview server when available; its address is recorded in the #549 handoff. It serves only `assets/docs/learning-design` and has no database, provider or member account. From the repository root, if no suitable preview is running:

```sh
python3 -m http.server 0 --bind 127.0.0.1 --directory assets/docs/learning-design
```

Open `http://127.0.0.1:<printed-port>/reader/`. Keep that process running; do not use the application's shared gate port. Reuse the same host and port to revisit browser saves. The earlier [request/check walkthrough](../prototype/README.md) remains available at `/prototype/` on the same server.

**Save in this browser** explicitly stores this route's current lesson/stage, responses, notes and self-checks at this origin. Switching routes preserves separate in-page drafts; reloading restores only explicit saves. Each content hash has a separate key under `dne-course-reader-1:<route>:<hash>`. Compatible original saves remain readable; new saves use the versioned key. The earlier prototype's storage is unchanged. There is no account save, server submission or reviewer exchange. Use invented information, especially on a shared browser.

**Download my work** keeps a text copy of the current route's sources and writing, including when saving fails. **Earlier notebooks** preserves and downloads previous stored records; their answers and self-checks are never automatically moved to new content. A readable earlier-content record does not block a separate current save, even if its answer options no longer exist. A malformed current record or unreadable original save remains protected from overwrite and separately downloadable. Earlier raw downloads include the stored version identifier and writing, not a complete old-lesson archive. There is no automatic migration, import or deletion tool.

## Refine and verify

Seven authored Markdown files and `feedback-cases.json` are the sources. `build.py` extracts route-specific content, verifies the structured feedback sources/comments against Lesson 6 and generates `course.mjs`, including all eight source hashes. It uses Python's standard library and supports the Markdown forms in these drafts; it is not a general renderer for external or member content. The new content hash preserves previous notebooks separately rather than silently copying their writing or self-checks.

```sh
python3 assets/docs/learning-design/reader/build.py
python3 assets/docs/learning-design/reader/build.py --check
node assets/docs/learning-design/reader/checks.mjs <reader-url> <evidence-directory>
```

Use the repository's installed Node 24+ and Playwright. The browser runner uses fresh Chromium contexts at 1360 × 950 and 390 × 950, without the application database or shared port. Add `--case READER-009`, for example, to reproduce source-switch checks. Its reports and screenshots are local-reader evidence, not the full application matrix.

## BDD and evidence

Sixteen [local scenarios](learning.feature) map to [executable checks](checks.mjs):

| IDs                             | Observable check                                                                                                                                                                                                 | Broader design connection                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| READER-001/002/003/008          | Six complete journeys: all lessons and final practice in three routes at both widths; wrong/correct choices, hints, fresh writing, comparison, earlier notes, final record and honest progress.                  | CREF-001/003/004/008; LEARN-FLOW-001/002/003/004/005/007/008/013; local APPLIED-LEARN teaching cases.              |
| READER-003 Work comparison      | Two additional desktop/narrow checks: six worked steps, correct action rows and unknowns, source recovery, preserved learner writing/self-check, and intact date words in the table.                             | Local comparison portion of APPLIED-LEARN-012; not a learner-comprehension result.                                 |
| READER-003 Technical comparison | Two additional desktop/narrow checks: six worked steps, sourced candidate rows, unknown JPEG behavior, separate execution/observation, conditional interrupted attempt and preserved learner writing/self-check. | Local teaching portions of APPLIED-LEARN-012/013; no actual upload-form execution or learner-comprehension result. |
| READER-004                      | Unsupported-route fallback, separate drafts, explicit save/reload, preserved prototype storage, and a leave warning only for changed writing.                                                                    | Local portions of LEARN-FLOW-010/011; no member ownership or account-goal mutation.                                |
| READER-005                      | Failed save retains writing and a downloadable source-bearing copy.                                                                                                                                              | Local portion of LEARN-FLOW-009; no server persistence result.                                                     |
| READER-006                      | Malformed original/current and different-content records remain unmodified and downloadable.                                                                                                                     | Local version/recovery portions of CREF-009 and LEARN-FLOW-012; no submitted-version migration.                    |
| READER-007                      | Three edit cases: fresh attempt, own work and final record clear old self-checks; HTML-looking writing stays literal through rendering/save/reload/download.                                                     | Local writing/reflection portions of LEARN-FLOW-008/013 and WORK-FLOW-004.                                         |
| READER-009                      | Three routes across six lessons: the sidebar follows the fresh source and labels the own-work reference as an example.                                                                                           | CREF-004; LEARN-FLOW-006/007.                                                                                      |
| READER-010                      | Desktop and narrow-screen continuation of the learner's starting work through Lessons 2–6; fresh/final sources and other routes stay separate.                                                                   | CREF-001/004; LEARN-FLOW-002/006.                                                                                  |
| READER-011                      | The schedule and draft versions needed to answer a practice question are visible in that question.                                                                                                               | CREF-003/008; APPLIED-LEARN-005/008/010.                                                                           |
| READER-012                      | Original and versioned earlier notebooks, changed answer options, explicit current save/reload and a failed save preserve earlier bytes.                                                                         | CREF-009; LEARN-FLOW-009/012.                                                                                      |
| READER-013/014                  | Three feedback decision journeys at both widths, exact source/comment context, revised or retained versions, reasons and structural validation.                                                                  | Local WORK-FLOW-003–005; no real reviewer exchange or semantic grade.                                              |
| READER-015/016                  | Save/reload/export, failed storage write, inconsistent-history protection, unfinished response, route isolation, self-check invalidation and literal writing.                                                    | Local WORK-FLOW-007 and LEARN-FLOW-009/010/013; no member or native transaction claim.                             |

The prior seventeen-case checkpoint covered the complete reader, fresh-source switch, leave warning and unsupported-route repair. The [substantive Everyday rehearsal](../everyday-author-rehearsal.md) added three scenario IDs and expanded the runner to twenty-five cases. Five initial repair checks failed against the baseline before implementation. The first full twenty-five-case run passed; self-review then reproduced two legacy-version failures when an answer option had been retired, while the versioned-history case already passed. The recovery fix preserves the old answer as historical bytes without validating it against the new key. Exact final results and source parity are recorded in the #549 handoff. These are local behavior checks plus author review, not an independent learner study.

The [Work author rehearsal](../work-author-rehearsal.md) completed a second substantive artifact and replaced its short final advice with a full six-part comparison. Two missing-record checks failed before authoring. Visual review also reproduced a narrow-table word-breaking problem before repair; that checkpoint passed 27 cases.

The [Technical author rehearsal](../technical-author-rehearsal.md) completed the third route and distinct final record. Its two missing-record checks failed before the full example was authored; that checkpoint passed 29 cases across twelve READER IDs. The original application journey register is unchanged. These results do not prove broader account, source-lifecycle, submission or staff-feedback requirements in [traceability](../traceability.md). Production work remains parked.

The [feedback workflow checkpoint](feedback-workflow.md) adds four scenario IDs and thirteen cases, bringing the full local reader suite to 42 passing checks. Six missing-workspace failures preceded implementation. The first full run also exposed six ambiguous existing comparison selectors; those were scoped to the intended disclosure without dropping their assertions, then all 42 passed. Actual author rehearsals saved/reloaded/exported all three decisions, and the earlier Technical notebook remained byte-identical.

The [content acceptance review](../content-acceptance-review.md) found a teaching weakness despite these passing interaction checks: the longest option selects 14 of 15 multiple-choice keys. Next under #549: refine those choices and their explanations, preserving source facts, IDs and earlier notebooks. Lead Sol/High; author design/self-review High. Preserve #93/#117 canonical-source and shared-reader claims. Production remains parked.
