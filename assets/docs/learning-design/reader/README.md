# AI, put to practice — complete local foundation reader

This reader makes all six authored lessons and the connected final practice usable in Everyday, Work and Technical routes. It is a local learning experiment under [#549](https://github.com/deepnative/deep-native-engine/issues/549), separate from the shared application reader owned in #117.

Choose a route, then follow **example → try → fresh case → your work**. Practice choices and claim classifications have hints, source-based explanations and retries. The reference panel switches to the fresh exercise's source; an own-work reference is explicitly an example. Earlier notes remain available throughout the sequence. The final practice supplies a fresh brief and six writing fields that connect the learned skills.

Opening a page is not completion. The path distinguishes written notes and a deliberate learner self-check. Editing fresh writing, lesson work or the final record clears the applicable previous self-check. Free writing has authored criteria and comparisons, not an automatic grade. Comparisons are supplied examples rather than responses generated from the learner's text.

## Run locally

Use the already running dedicated content-preview server when available; its address is recorded in the #549 handoff. It serves only `assets/docs/learning-design` and has no database, provider or member account. From the repository root, if no suitable preview is running:

```sh
python3 -m http.server 0 --bind 127.0.0.1 --directory assets/docs/learning-design
```

Open `http://127.0.0.1:<printed-port>/reader/`. Keep that process running; do not use the application's shared gate port. Reuse the same host and port to revisit browser saves. The earlier [request/check walkthrough](../prototype/README.md) remains available at `/prototype/` on the same server.

**Save in this browser** explicitly stores this route's current lesson/stage, responses, notes and self-checks at this origin. Switching routes preserves separate in-page drafts; reloading restores only explicit saves. Separate keys under `dne-course-reader-1` leave the earlier prototype's storage unchanged. There is no account save, server submission or reviewer exchange. Use invented information, especially on a shared browser.

**Download my work** keeps a text copy of the route's sources and writing, including when saving fails. A malformed or different-content saved record is not loaded or overwritten; the original stored copy is separately downloadable, while new practice remains editable and downloadable. The version check prevents old answers being presented against silently changed sources. No automatic migration is implemented.

## Refine and verify

The seven authored Markdown files are the source. `build.py` extracts route-specific content and generates `course.mjs`, including source hashes. It uses Python's standard library and supports the Markdown forms in these drafts; it is not a general renderer for external or member content.

```sh
python3 assets/docs/learning-design/reader/build.py
python3 assets/docs/learning-design/reader/build.py --check
node assets/docs/learning-design/reader/checks.mjs <reader-url> <evidence-directory>
```

Use the repository's installed Node 24+ and Playwright. The browser runner uses fresh Chromium contexts at 1360 × 950 and 390 × 950, without the application database or shared port. Add `--case READER-009`, for example, to reproduce source-switch checks. Its reports and screenshots are local-reader evidence, not the full application matrix.

## BDD and evidence

Nine [local scenarios](learning.feature) map to [executable checks](checks.mjs):

| IDs | Observable check | Broader design connection |
| --- | --- | --- |
| READER-001/002/003/008 | Six complete journeys: all lessons and final practice in three routes at both widths; wrong/correct choices, hints, fresh writing, comparison, earlier notes, final record and honest progress. | CREF-001/003/004/008; LEARN-FLOW-001/002/003/004/005/007/008/013; local APPLIED-LEARN teaching cases. |
| READER-004 | Unsupported-route fallback, separate drafts, explicit save/reload, preserved prototype storage, and a leave warning only for changed writing. | Local portions of LEARN-FLOW-010/011; no member ownership or account-goal mutation. |
| READER-005 | Failed save retains writing and a downloadable source-bearing copy. | Local portion of LEARN-FLOW-009; no server persistence result. |
| READER-006 | Two checks: malformed and different-content records remain unmodified and downloadable. | Local version/recovery portions of CREF-009 and LEARN-FLOW-012; no submitted-version migration. |
| READER-007 | Three edit cases: fresh attempt, own work and final record clear old self-checks; HTML-looking writing stays literal through rendering/save/reload/download. | Local writing/reflection portions of LEARN-FLOW-008/013 and WORK-FLOW-004. |
| READER-009 | Three routes across six lessons: the sidebar follows the fresh source and labels the own-work reference as an example. | CREF-004; LEARN-FLOW-006/007. |

Seventeen browser cases exercise these nine IDs. The first baseline failed because the reader was absent. The first thirteen-case implementation run passed. Author inspection then found that the reference panel retained the worked source during transfer; all three new source-switch checks failed before the fix. Their focused green result and the sixteen-case pass are separate records. A later walkthrough reproduced an unnecessary leave warning after reading alone; a new check failed before the warning was limited to changed writing, then passed. Self-review also reproduced a crash for an unsupported route named like an inherited object property; route selection now accepts only the three explicit route keys. The final seventeen-case run includes all three repairs. Source parity and rendered desktop/narrow-width inspection complement the behavior checks. This is author review, not an independent learner study.

The original application journey register is unchanged. These results do not prove broader account, source-lifecycle, submission or staff-feedback requirements in [traceability](../traceability.md). Production work remains parked.

Next bounded action under #549: walk the complete Everyday route with substantive learner answers, identify confusing wording or missing transitions, and refine the affected source plus BDD evidence. Automated interaction checks do not establish comprehension or lesson quality. Lead Sol/High; author self-review High. Preserve #93/#117 canonical-source and shared-reader claims.
