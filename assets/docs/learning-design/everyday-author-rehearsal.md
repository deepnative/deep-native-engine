# Everyday course: author rehearsal and refinement

On 27 October 2026, Codex completed the six-lesson Everyday path and the separate final practice through the local reader, using substantive invented answers. Baseline: `705f27adcd3afb74b35ecf3f32b5df2987163f86`; content hash: `38b577266c608cbed8903ef1ac26376f70f1c14a8c1367c2d631bdcb51b545a0`. This was an author rehearsal with prior knowledge of the examples and answer keys. It does not measure independent comprehension, difficulty, completion time or learner satisfaction.

Scope is [#549](https://github.com/deepnative/deep-native-engine/issues/549), claim `DNE-2026-10-27-549-everyday-rehearsal-root`, in `assets/docs/learning-design/` only. Production remains parked. No real AI call, reviewer, member submission, outreach or event announcement occurred.

## The work produced

The continuing source was **BOOK-1**, the invented Lesson 1 fresh case: eight helpers, thirty donated books, free entry, Sunday afternoon, location unconfirmed. The author chose one short invitation and carried this same source through all six own-work stages. The separate worked examples and fresh-case answers retained their own facts.

| Step | Concrete work and author judgment against the criterion |
| --- | --- |
| Choose | A short invitation, with an explicit comparison of numbers, price and timing against BOOK-1. The location and exact time remain open. |
| Request | Context, task, headline/two-sentence shape, limits and source check are explicit. No attendance guarantee is inferred from thirty books. |
| Check | Deliberately flawed v1 used ten helpers, $5, a library and 2 p.m. The claim table marks count/price contradicted and place/time not given, while retaining supported facts. |
| Use/share | The invitation remains invented private practice. The audience decision distinguishes saving from actual publication or a request for feedback. |
| Repeat | Input → draft → claim checks → keep/revise/set aside → recovery is applied to v1. It does not invent a duration or claim that event capacity was checked. |
| Improve | Self-written practice feedback concerns v1. Its corrections already appear in v2, so the record retains v2 and explains “already addressed” without inventing a reviewer or cosmetic v3. |

Retained invitation v2:

> **Free Sunday book swap**
>
> Eight helpers and thirty donated books are planned for a free book swap on Sunday afternoon. The location is to be confirmed.

The final practice starts a **different artifact using CAP-E**: five helpers, ninety minutes on Saturday, fifteen inspections, no repair guarantee, and undecided room/start time. All six final fields were completed before opening the worked comparison. The repair removed six helpers, twenty items, a guaranteed repair, 2 p.m. and an assumed workshop. A proposed 15/60/15-minute sequence has peak demand of five helpers; the answer explicitly states that those two checks do not prove activity feasibility or completion of every inspection.

The author judged all six final rubric criteria shown, with pointers to the task, request, claim table, audience scope, recovery action and retained versions. This is inspectable reasoning and self-assessment, not an independent grade. All six fresh cases also received substantive source-specific responses.

## Observations that caused changes

| Observed baseline | Refinement | BDD / verification |
| --- | --- | --- |
| L1 acknowledged a correct B response, then said “Try again”; the shared practice footer did the same. | The authored explanation states the measurable limits. Incorrect responses invite correction; correct responses lead to a fresh case. | Expanded READER-002; failing correct-response check before repair. |
| L2's Everyday comparison ended with launch-date/message-limit wording; L4 referred to “the first two cases” although the reader displays one route. | Shared prose now stands on its own for the selected case. Source facts and answer keys remain unchanged. | Source/answer/comparison inspection and generated-content parity; CREF-003/004. |
| During L2–6 own work, the visible reference was a separate drill source. BOOK-1 was available only inside collapsed earlier notes. | “Your starting work” shows the learner's Lesson 1 notes beside later own work, explicitly telling them to check the original source. Fresh and final cases remain separate. | READER-010 at desktop and narrow widths; failure before repair. This was a continuity gap, not observed source corruption or a proven learner mistake. |
| L5 asked about “the first schedule” after it had disappeared. L6 referred to drafts not present with the question. | The affected questions include the original schedule or v1/v2 text needed to answer them. | READER-011; missing-context failure before repair. |
| An authored update made earlier browser work unavailable for restoration and blocked new saves. | Separate content-version notebooks retain downloadable old records while permitting an explicit current save. No answers or self-checks are imported. | READER-012 plus READER-006; failures before repair, success and quota-failure recovery checks. |
| Self-review found that a retired answer option still blocked legacy-version recovery. | Old answers remain historical bytes; they are not validated against the new answer options or restored into new lessons. | Two legacy cases failed and the versioned case passed before this correction. |

The reader retains malformed-current-record protection, escaping of learner writing, explicit self-check invalidation, separate routes, the earlier prototype's storage and the original application journey register.

## Reproducible evidence and limits

The dedicated preview remains at `http://localhost:56274/reader/`, served by the existing content-only server. Its `localhost` storage was initially empty; the earlier `127.0.0.1` demonstration notebook was not overwritten. Restart instructions are in the [reader README](reader/README.md); changing host or port changes browser storage.

Local evidence folder: `/Users/tomwu/Documents/Codex/2026-10-27/dne-content-workflows-bdd/everyday-rehearsal/`.

- `baseline-learning-record.txt`: actual browser download of all six lessons, fresh responses and final record.
- `baseline-sources/` and `baseline.json`: the seven original authored files, revision and checksums.
- `earlier-notebook.json`: actual earlier-version download after refinement, with all six own responses, six fresh responses and six final fields intact.
- `version-recovery.json`: the earlier download remained byte-for-byte identical after a current notebook was saved and reloaded. SHA-256: `ac8c87590d35a214a7189fd6a6f441fe33fba76bb17c57726edd37a5e09c8ece`.
- `current-learning-record.txt`: Lessons 1 and 2 deliberately re-entered and rechecked against unchanged BOOK-1 facts. It is a partial current-version notebook, not another complete rehearsal.
- `red/`, `green/`, `full-run/`, `retired-answer-red/`, `retired-answer-green/`: retained behavioral runs, without retries. `final-run/results.json` records all 25 cases passing after the last recovery fix. The committed-tree manifest is linked in the issue handoff.

The focused runner now has 25 cases across 12 READER IDs. It exercises all three routes on desktop and narrow screens, plus targeted continuity/version-recovery cases. Source generation checks all seven authored files and 21 route-specific lesson/final views. These checks do not establish the full application gate, hosted behavior or teaching effectiveness. Author self-review inspected the changed source, feedback, revision metadata, reader diff and rendered layouts. No independent review is claimed.

## Next bounded action

Under #549, rehearse the Work route with one substantive project across Lessons 1–6 and its distinct final brief. Inspect task-specific owners, dates and feedback decisions, then refine only problems demonstrated by that work. Lead Sol/High; author design/self-review High. The current local content is sufficient to begin; canonical adoption and the shared application reader remain coordinated with #93/#117 and outside this scope.
