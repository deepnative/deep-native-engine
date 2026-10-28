# Learn by making something useful

A local content and workflow draft for [#549](https://github.com/deepnative/deep-native-engine/issues/549), prepared 27 October 2026. **Start with the [complete local reader](reader/README.md), or read a lesson below.** It connects all six authored lessons and final practice with route-specific examples, feedback and a browser-local notebook.

Lesson 2 now includes [three follow-up conversations](study-dialogues.md): use a hint, repair a specific misconception and explain the change while keeping your own writing.

The [local Lesson 2 → 3 walkthrough](prototype/README.md) now lets you try the sequence: write a request, classify a supplied answer, revise it and explain the change. Its saves are explicitly browser-local. The prototype includes eight additional scoped BDD scenarios and focused executable browser checks; it does not add application journey coverage.

For content creation, open the [authoring workshop](authoring/README.md): correct an answer key or refine a staffing request, try the learner preview, compare the wording and retain a separate local revision with its reason. Both editorial journeys have been rehearsed through save, reload and export.

Each route now has a more realistic final exercise: [Everyday book-swap planning](realistic-everyday-practice.md), [a Work handover pilot](realistic-work-practice.md) and [a Technical upload investigation](realistic-technical-practice.md). Produce a useful reminder, update or investigation from changing records, then retain a revision and its reason. Different workable plans and wording are accepted.

The final practice now includes an optional [contribution exercise](contribution-practice.md): identify a faulty workflow, write a proposal, use supplied editorial feedback and retain both versions with a reason. The local worksheet can be saved or downloaded.

For learner behavior, Lesson 6's [feedback decision workspace](reader/feedback-workflow.md) now makes revise, decline and already-addressed outcomes interactive. It preserves the original comment and draft versions, keeps the learner's reason and clarification, and saves with the existing notebook.

| Read as a learner                                                           | What you will make                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [1. Choose a task you can check](lessons/01-choose-a-checkable-task.md)     | A small task, its source and a check.                                    |
| [2. Write a useful request](lessons/02-write-a-useful-request.md)           | A request with facts, output shape, limits and a check.                  |
| [3. Check an answer](lessons/03-check-an-answer.md)                         | A claim-by-claim review and a corrected answer.                          |
| [4. Choose what to use and share](lessons/04-choose-what-to-share.md)       | A useful invented sample and a deliberate audience decision.             |
| [5. Build a repeatable workflow](lessons/05-build-a-repeatable-workflow.md) | Input, draft, check, decision and recovery steps.                        |
| [6. Give feedback someone can use](lessons/06-feedback-and-revision.md)     | A feedback decision, revised or retained text and a source-based reason. |
| [Put the six lessons together](foundation-practice.md)                      | One connected learning record using a fresh brief.                       |

Each lesson offers Everyday, Work and Technical routes. Choose one rather than reading all three. Every route has supplied facts, a worked example, a practice attempt, specific feedback, a fresh case and an own-work self-check. Learners can use the invented samples throughout, without an AI account.

All six lessons in the [curriculum map](curriculum.md) now have full drafts. These proposals live separately from the canonical FND files owned by the ongoing #93/#117 work. The final practice contains complete source-to-revision worked records for Everyday, Work and Technical routes.

## What the study changes

Khan Academy describes its revised learning experience around clear next steps, meaningful practice and timely feedback. Our design uses one recommended next action and keeps the source beside the attempt. [Khan Academy's classroom experience](https://blog.khanacademy.org/meet-the-new-khan-academy-classroom-experience/).

Duolingo describes starting with simpler exercises, moving to new contexts, and offering hints and short explanations. Its answer-explanation feature addresses the learner's particular mistake. Our design uses a worked example, answer-specific feedback and a fresh case before the learner applies the skill to their own artifact. [Duolingo teaching method](https://blog.duolingo.com/duolingo-teaching-method/), [answer explanations](https://blog.duolingo.com/explain-my-answer-now-free/).

These are design interpretations of their published approaches, not evidence that our drafts achieve the same learning results. All lesson text and cases here are original synthetic material. No competitor lesson, illustration or branded interface is copied. Official sources were checked on 27 October 2026; feature availability can vary by course/account.

## Inspect the behavior

- [Content and learner workflows](workflows.md): author → check → preview → refine; learner → attempt → correction → application; feedback → revision.
- [Content refinement BDD](features/content-refinement.feature): 12 scenarios, including incorrect keys, plausible alternatives, source uncertainty and version changes.
- [Learner journey BDD](features/learner-journey.feature): 14 scenarios, including hints, save/resume, goal changes and honest progress.
- [Feedback and revision BDD](features/feedback-revision.feature): 7 scenarios, including exact-version feedback, clarification, revision and recovery.
- [Applied learning BDD](features/applied-learning.feature): 13 concrete scenarios for Lessons 4–6 and the connected practice, including unsupported feedback and interrupted execution.
- [Authoring workshop BDD](authoring/authoring.feature): eight scoped scenarios for correction, preview, revision history and recovery, backed by 12 focused browser checks.
- [Practice refinement](practice-refinement.md): fifteen revised questions, thirty misconception/repair rationales and before/after diagnostics.
- [Study dialogues](study-dialogues.md): three source-grounded follow-ups, four workflow specifications and six added browser cases; the checkpoint passed 78 checks.
- [Contribution practice BDD](features/contribution-practice.feature): four content scenarios and four added reader scenarios, backed by twelve added browser cases.
- [Realistic Work BDD](features/realistic-work-practice.feature): five content/workflow scenarios plus two reader cases for retained drafts, source updates and save/export/reload.
- [Realistic Technical BDD](features/realistic-technical-practice.feature): five content/workflow scenarios plus two reader cases for a bounded investigation, new requirements and retained writing.
- [Realistic Everyday BDD](features/realistic-everyday-practice.feature): five content/workflow scenarios plus two reader cases for changed arrangements, confirmed/reserved counts, capacity and retained revisions.
- [Guided final practice](reader/guided-final-practice.md): four free steps, retained writing, compact source reminders and compatible explicit saves; three reader scenarios and eleven added browser cases.
- [Evidence and acceptance map](traceability.md): the original 32 scenarios plus the new applied-learning map, with authored, existing, partial and proposed behavior separated.

For example:

```gherkin
Scenario: LEARN-FLOW-007 — Distinguish a contradiction from a missing fact
  Given Source E3 says twelve volunteers and an undecided budget
  When the learner classifies "fifteen volunteers" and "$200 budget"
  Then "Contradicted" is the correct classification for fifteen volunteers
  And "Not given" is the correct classification for the budget
  And feedback names the source fact or missing information for each claim
  And the repair retains twelve volunteers and leaves the budget open
```

## Working state

Authored drafts: `LD-FND-001` through `LD-FND-006`, corresponding to FND-001 through FND-006. The [practice refinement](practice-refinement.md) brings Lessons 1, 4, 5 and 6 to revision `0.3`; the [follow-up dialogues](study-dialogues.md) bring Lesson 2 to `0.4`. Lesson 3 remains `0.1`. These are proposal identifiers, not published catalog versions. The original source baseline is local commit `60c66677d939df8b1d0b59c43a1e8627f45223bc`; later local commits record the authored refinements and prototypes separately.

The existing #548 guide and standalone request/check prototype demonstrate narrower loops. The six-lesson reader makes the complete authored sequence locally usable. This package does not change the hosted application. The 32 original and 13 applied-learning BDD scenarios retain their broader scope; CREF-012 adds the option-design review; four DIALOGUE, four CONTRIB, five REAL-WORK, five REAL-TECH, five REAL-EVERY, eight PROTO, twenty-eight READER and eight AUTHOR scenarios identify separately scoped local behavior. The package has 113 unique IDs. None changes the approved application journey register.

Routine content and wording choices proceed under the owner's instruction. Production work is parked. Everyday, [Work](work-author-rehearsal.md) and [Technical](technical-author-rehearsal.md) rehearsals contain connected artifacts and separate final records. The authoring workshop demonstrates critique → correction → preview → comparison → saved revision. Lesson 6 supports revise, decline and already-addressed decisions with saved/exported records.

The [practice refinement](practice-refinement.md) resolves the [earlier review's](content-acceptance-review.md) recurring longest-answer cue: unique-longest matches fell from 14/15 to 3/15, with ties reported separately. All 24 keys are preserved; each of the fifteen revised items has specific mistake-and-repair feedback. The full reader suite now passes 107 checks, including the follow-up dialogues, optional contribution worksheet, realistic Everyday/Work/Technical cases and guided final-practice steps, and actual old-notebook downloads remain unchanged. These are author and local-behavior results, not proof of learning effectiveness.

The [guided final-practice checkpoint](reader/guided-final-practice.md) now presents all three cases as brief → first draft → update → revision, preserving existing writing and explicit saves. READER-026–028 add eleven browser cases; the full reader suite has 107 passing cases.

Next bounded content action under [#34](https://github.com/deepnative/deep-native-engine/issues/34): give each final-practice writing field a short route-specific prompt, drawing from its existing first-pass instructions. The staged rehearsal still shows generic field labels/placeholders; learners must reopen the instruction disclosure to recover the exact reminder, update or investigation requirements. Preserve the three source packets, alternative valid solutions, first/revised writing and notebook compatibility. Preserve #93/#117 canonical/shared-reader claims and recheck live ownership before starting. Lead Sol/High; author design/self-review High. Production remains parked.
