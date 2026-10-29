# Content acceptance review

Author review for [#549](https://github.com/deepnative/deep-native-engine/issues/549), 27 October 2026. Reviewed content: `11d6a7f6dbe2adb2e4bf70769a05cc2529505584`, content hash `a63aa78cb2a451f4bbaba9b38d1e31efe61741d4aff8469402ea8d9760975178`. Codex performed this audit as the author. No independent learner study or new application test run is claimed.

**Historical baseline finding:** the six-lesson package was inspectable and its supplied answers were factually consistent, but the unique-longest-option rule selected 14 of 15 multiple-choice keys. The audit below records that reviewed revision.

**Resolution, 27 October:** the [practice refinement](practice-refinement.md) rewrites those fifteen items and their hints/explanations, records all thirty misconception/repair rationales, preserves the keys and earlier notebooks, and passes 72 local reader checks. Unique-longest matches are now 3/15; tie-aware results and limits are in that report. The earlier AC2 finding is resolved within author content review. Its final section contains the current next action; the proposed rewrite below remains historical evidence.

## Findings

### P2 — Answer wording gives away too many keys

At the reviewed revision, every Everyday and Work multiple-choice key is the unique longest option. Technical has the same pattern in four of five items. The rule uses character count only; it reads neither the supplied source nor the meaning of a choice. The fifteen items are the three routes in Lessons 1, 2, 4, 5 and 6. Lesson 3's nine fixed-label classification items are outside this measurement.

| Route     | Unique longest option matches key | Exception                                    |
| --------- | --------------------------------- | -------------------------------------------- |
| Everyday  | 5 / 5                             | None                                         |
| Work      | 5 / 5                             | None                                         |
| Technical | 4 / 5                             | L1-T-P: the longer A is wrong; C is correct. |

Concrete examples:

- [L2-E-P](lessons/02-write-a-useful-request.md#everyday-question--l2-e-p): the correct C has 107 characters, versus 56 and 58. It collects the useful checks while the alternatives assume a venue or suppress uncertainty.
- [L2-W-P](lessons/02-write-a-useful-request.md#work-question--l2-w-p): B has 96 characters, versus 40 and 65. It supplies both source preservation and checking; the alternatives assign every date to Tuesday or infer ownership from name proximity.
- [L6-E-P](lessons/06-feedback-and-revision.md#everyday-question--l6-e-p): A has 143 characters, versus 69 and 63. A contains observation, evidence, repair and a limit; B offers a confidence-based score and C invents another time.

This is a reproducible item-design weakness, not evidence that a particular learner guessed or failed to learn. The source-based keys remain correct. Some alternatives are legitimate beginner misconceptions, but repeatedly pairing the most detailed response with obviously unsupported behavior makes surface wording an alternative route to the key. AC2 asks for plausible wrong answers; this pattern needs another editorial pass.

Repair the alternatives as competing attempts at the same task. Each wrong choice should contain a plausible, specific error the feedback can name. Keep similar forms and levels of detail without padding text to satisfy a length quota. Then rerun the cue analysis as a diagnostic alongside semantic review; a lower count alone will not prove better teaching.

### P3 — Entry documents recommend work that already exists

At the reviewed revision, `authoring/README.md` says the reader does not provide a structured feedback decision, while Lesson 6 already does. `prototype/README.md` asks for the Everyday rehearsal that has already been recorded. That can send the next content pass back into delivered work. This audit updates their next-action sections, the reader entry and the package index to point here. Their historical evidence and local-storage limits remain intact.

## AC1–6 disposition at the audited revision

| Issue criterion                                                                           | Direct current evidence                                                                                                                                                                    | Disposition and limit                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1: outcomes, prerequisites, artifacts and next steps across audiences                   | [Curriculum](curriculum.md); six lesson openings, own-work prompts and take-forward links; route-specific reader sequence.                                                                 | Authored and locally inspectable. No employment, coding, purchase or AI account is needed. Durations remain author estimates.                                                                                                                             |
| AC2: connected core lessons with source, example, practice, feedback, transfer and rubric | Lessons 1–3 contain all required parts; Lessons 4–6 and final practice extend them. All 24 practice keys, 18 fresh cases and three final comparisons were inspected against their sources. | Factual review found no incorrect key or worked correction. **Needs refinement:** the choice-design finding above affects core Lessons 1–2 as well as the extension. No observed learning gain is established.                                            |
| AC3: creation, refinement, versions, retirement and rights in BDD                         | [Workflows](workflows.md), CREF-001–011, the two authoring workshop cases and their actual v2 exports.                                                                                     | Captured as concrete specification, with bounded local revision behavior. Catalog adoption/retirement and uncertain external rights remain explicit procedural or proposed behavior, not newly executed services.                                         |
| AC4: learner and feedback behavior, privacy and recovery                                  | LEARN-FLOW-001–014, WORK-FLOW-001–007, APPLIED-LEARN-001–013; reader, prototype and feedback records.                                                                                      | Specified; local attempts, hints, retry, writing, route separation, version recovery and feedback decisions have scoped evidence. Member accounts, real review exchange and native transaction/privacy guarantees are not supplied by a browser notebook. |
| AC5: exact evidence mapping and preserved IDs                                             | [Traceability](traceability.md), scoped README maps, retained reports and hashes.                                                                                                          | All 77 design/local IDs remain: 32 original + 13 applied + 8 PROTO + 16 READER + 8 AUTHOR. Application IDs/denominators are unchanged. Existing application analogues are source references, not test passes from this audit.                             |
| AC6: easy local inspection, consistency, rights and one next action                       | Package index, reader/authoring entry points, source generation, link/ID checks and this review.                                                                                           | Inspectable locally; contradictory next-action text is corrected here. The next action is the bounded practice-item refinement below. Publication and production remain parked.                                                                           |

## Source, feedback and transfer audit

The table records author judgments from the actual text, not automatic semantic grades. Practice keys were checked separately from the presence of sections. Lesson 3 includes nine classifications; each other lesson has three multiple-choice keys.

| Lesson               | Everyday route                                                                                                        | Work route                                                                                                         | Technical route                                                                                                              | Transfer and artifact demand                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: task and check    | Twelve people/two hours; venue and budget remain open. B names a checkable draft.                                     | Sam/checklist, Alex/feedback and Tuesday/trial stay attached to their own tasks. A retains unknowns.               | C proposes cases with not-run status; a requirement is not execution evidence.                                               | New book-swap, pilot and PDF facts; produce a task and a check, then keep source/task/check/unknown lines.                                                                              |
| 2: useful request    | C adds simultaneous staffing and unknowns; staffing summed across sequential slots is not peak demand.                | B preserves task-specific dates and owners instead of spreading Tuesday to every row.                              | A adds requirement linkage and not-run status without inventing results.                                                     | Seed-swap invitation, survey table and contact-form cases require a new request with a check. Rubric accepts equivalent wording. Cue finding is especially visible here.                |
| 3: source checking   | Twelve is supported; fifteen conflicts; $200 is not given. Correction retains useful facts.                           | Alex's feedback task is supported; Friday conflicts with Tuesday; Monday deadline is not given.                    | Required explanation is supported; completed tests conflict with no execution; password minimum is not given.                | Reading group, agenda and PNG/JPEG cases require classification and repair. Missing evidence is not treated as proof of falsehood.                                                      |
| 4: use/share         | B keeps useful invented counts/time without a contact sheet.                                                          | C uses a new fictional process problem rather than merely renaming a complaint.                                    | A retains the blank-message behavior without the original log or credential.                                                 | Limited public notice/update and a named maintainer case require a useful sample, audience and omitted detail. Permission comes from each fictional brief, not a universal prohibition. |
| 5: workflow          | B fixes both 65→60 minutes and seven→six peak helpers. The fresh case already fits thirty minutes but fails staffing. | C traces commitments. The fresh missing-source case stays unverified instead of becoming false or confirmed.       | A recovers a draft without fabricating a test result. A later interrupted execution has no observed outcome.                 | New checks, justified use and recovery are required. Passing counts is explicitly narrower than proving practical feasibility.                                                          |
| 6: feedback decision | A links the incorrect count/time to E6 and a usable repair. Fresh advice is unsupported and may be declined.          | C keeps Mina's known task without turning the trial date into her deadline. Fresh v2 already fixes its v1 comment. | B recognises changes already made without inventing a new review. Fresh PDF wording needs a revision from passed to not run. | Fresh outcomes rotate across revise, decline and already addressed. Reasons and versions matter; agreement or an edit alone is not the outcome.                                         |

The fresh cases change supplied facts and require constructed responses. They are mainly **near transfer** within the same source-checking pattern. The six-stage final records increase the amount of work to connect; this does not establish that a learner can generalise unaided to an unfamiliar domain.

| Final case | Checked reasoning                                                                                                                                                                                | Useful retained artifact                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| CAP-E      | Five helpers/ninety minutes/fifteen inspections; repair guarantees, room and start time cannot be invented. The schedule totals ninety with peak five, without claiming all work is feasible.    | Proposed schedule, corrected claims, internal audience, source recovery and a revision reason.                                                   |
| CAP-W      | Noor writes one page, Lee gathers four comments, trial Wednesday. Tuesday deadline, Friday trial and Lee as decision owner require different corrections. No comment/trial sequence is invented. | Task/owner/date table, specific open questions, internal use and retained v1/v2 feedback history.                                                |
| CAP-T      | PNG up to 3 MB; other formats open; no execution. Candidate acceptance/boundary/rejection rows are expectations. Byte convention and error wording remain unspecified.                           | Candidate tests with separate expected/executed/observed fields; interrupted future attempt stays separate from the original no-tests-run brief. |

## What the evidence establishes

The reader's retained report has **42 passed, zero failed, zero retries**, including its 29 earlier cases and 13 feedback cases. Its changed runtime files match the committed hashes at the reviewed revision. The authoring workshop's five runtime/check files also still match its recorded `c97347e` checkpoint, which has 12 passing cases. These reports were inspected, not rerun during this documentation audit. The older prototype report remains the historical evidence described in its README.

Recorded author artifacts contain substantive Everyday, Work and Technical own-work/final responses, two authoring revisions and three feedback decisions. They establish that the author could perform those local journeys with known invented cases. They do not measure independent learner comprehension, duration, retention or task success. The content audit supplies the missing judgment that a green interaction suite cannot make: the keys can be correct while the choices remain too easy to recognise.

The original FND sources remain unchanged. Their community plan, action-table and sign-up examples are traceable in FND-001/002/003; this package elaborates those ideas in a separate directory. It uses original fictional material and case-specific permission statements. No private learner artifact or competitor exercise was adopted into the lessons.

The three study links were rechecked for the claims used in the package: Khan Academy describes clearer next steps and feedback; Duolingo describes a progression from simpler practice to new contexts, with hints and explanations tailored to mistakes. These inform our design, not an effectiveness claim. [Khan Academy](https://blog.khanacademy.org/meet-the-new-khan-academy-classroom-experience/), [Duolingo method](https://blog.duolingo.com/duolingo-teaching-method/), [Duolingo explanations](https://blog.duolingo.com/explain-my-answer-now-free/).

Evidence directory: `/Users/tomwu/Documents/Codex/2026-10-27/dne-content-workflows-bdd/content-audit/`. `item-cue-audit.json` records every item/key/length and the analysis boundary; `audit_items.py` reproduces it. Static/reference checks and the final committed-file manifest are recorded separately. No application files, lesson text, runtime or tests change in this audit.

## Refinement proposed by this audit

Under #549, revise the **15 multiple-choice practice items in Lessons 1, 2, 4, 5 and 6**, with their hints/explanations, so choices are competing attempts with specific mistakes. Keep source facts, outcomes, question IDs, correct-key identity, fresh cases and learner notebooks intact. Do not rewrite Lesson 3's classification keys or introduce automatic grading of free writing. Regenerate the reader's content version and verify earlier notebook recovery; record the exact before/after teaching changes. Existing content and tools suffice. Coordinate later canonical/shared-reader adoption with #93/#117; preserve #103/#114 work. Lead Sol/High; author semantic review High, separate Astra review only if requested or actually required.

For example, a **candidate** replacement for L2-E-P would compare these additions to the same request; this is an editorial sketch, not active reader wording:

- A: Add total volunteer-hours; leave venue, budget and start time open.
- B: Add volunteers needed per slot; use 9 a.m. as the start, with venue and budget open.
- C: Add volunteers needed per slot; leave venue, budget and start time open.

A can hide an overstaffed slot even if total volunteer-hours fit. B adds a start time the source does not give. C makes the simultaneous constraint inspectable while keeping unknowns open. Each option attempts useful planning; the deciding difference is the source/check rather than enthusiasm versus caution.

The next change should record stable scenarios before implementation. Its proposed behavior is:

```gherkin
Scenario: Compare plausible requests using the supplied facts
  Given the source provides twelve volunteers and two hours but no start time
  When the learner compares alternative additions to the same planning request
  Then the correct choice makes each slot's staffing inspectable and keeps the time open
  And each wrong choice contains a specific explainable error
  And its feedback names that error and a concrete repair

Scenario: Refine practice without rewriting earlier work
  Given a notebook was saved with the earlier question wording
  When the learner opens the refined content version
  Then the earlier notebook remains separately identifiable and downloadable
  And its answers are not silently graded against the new wording
  And current practice uses the revised choices and their matching explanations
```

These are proposed acceptance examples, not extra executed scenarios or additions to the 77-ID register. Review every option for meaning; compare the wording-only cue result before and after; run the full focused reader checks and inspect a substantive attempt. The audit left #549 open for this finding; the linked refinement now records its resolution. Production and the full thread goal remain separate from this local content checkpoint.
