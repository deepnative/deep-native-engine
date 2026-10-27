# Learn by making something useful

A local content and workflow draft for [#549](https://github.com/deepnative/deep-native-engine/issues/549), prepared 27 October 2026. **Start with the [complete local reader](reader/README.md), or read a lesson below.** It connects all six authored lessons and final practice with route-specific examples, feedback and a browser-local notebook.

The [local Lesson 2 → 3 walkthrough](prototype/README.md) now lets you try the sequence: write a request, classify a supplied answer, revise it and explain the change. Its saves are explicitly browser-local. The prototype includes eight additional scoped BDD scenarios and focused executable browser checks; it does not add application journey coverage.

| Read as a learner | What you will make |
| --- | --- |
| [1. Choose a task you can check](lessons/01-choose-a-checkable-task.md) | A small task, its source and a check. |
| [2. Write a useful request](lessons/02-write-a-useful-request.md) | A request with facts, output shape, limits and a check. |
| [3. Check an answer](lessons/03-check-an-answer.md) | A claim-by-claim review and a corrected answer. |
| [4. Choose what to use and share](lessons/04-choose-what-to-share.md) | A useful invented sample and a deliberate audience decision. |
| [5. Build a repeatable workflow](lessons/05-build-a-repeatable-workflow.md) | Input, draft, check, decision and recovery steps. |
| [6. Give feedback someone can use](lessons/06-feedback-and-revision.md) | A feedback decision, revised or retained text and a source-based reason. |
| [Put the six lessons together](foundation-practice.md) | One connected learning record using a fresh brief. |

Each lesson offers Everyday, Work and Technical routes. Choose one rather than reading all three. Every route has supplied facts, a worked example, a practice attempt, specific feedback, a fresh case and an own-work self-check. Learners can use the invented samples throughout, without an AI account.

All six lessons in the [curriculum map](curriculum.md) now have full drafts. These proposals live separately from the canonical FND files owned by the ongoing #93/#117 work. The final practice contains a complete Everyday worked record and source-based checks for Work and Technical routes.

## What the study changes

Khan Academy describes its revised learning experience around clear next steps, meaningful practice and timely feedback. Our design uses one recommended next action and keeps the source beside the attempt. [Khan Academy's classroom experience](https://blog.khanacademy.org/meet-the-new-khan-academy-classroom-experience/).

Duolingo describes starting with simpler exercises, moving to new contexts, and offering hints and short explanations. Its answer-explanation feature addresses the learner's particular mistake. Our design uses a worked example, answer-specific feedback and a fresh case before the learner applies the skill to their own artifact. [Duolingo teaching method](https://blog.duolingo.com/duolingo-teaching-method/), [answer explanations](https://blog.duolingo.com/explain-my-answer-now-free/).

These are design interpretations of their published approaches, not evidence that our drafts achieve the same learning results. All lesson text and cases here are original synthetic material. No competitor lesson, illustration or branded interface is copied. Official sources were checked on 27 October 2026; feature availability can vary by course/account.

## Inspect the behavior

- [Content and learner workflows](workflows.md): author → check → preview → refine; learner → attempt → correction → application; feedback → revision.
- [Content refinement BDD](features/content-refinement.feature): 11 scenarios, including incorrect answer keys, source uncertainty and version changes.
- [Learner journey BDD](features/learner-journey.feature): 14 scenarios, including hints, save/resume, goal changes and honest progress.
- [Feedback and revision BDD](features/feedback-revision.feature): 7 scenarios, including exact-version feedback, clarification, revision and recovery.
- [Applied learning BDD](features/applied-learning.feature): 13 concrete scenarios for Lessons 4–6 and the connected practice, including unsupported feedback and interrupted execution.
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

Authored drafts: `LD-FND-001` through `LD-FND-006`, corresponding to FND-001 through FND-006. The [Everyday author rehearsal](everyday-author-rehearsal.md) refined Lessons 1, 2, 4, 5 and 6 to revision `0.2`; Lesson 3 remains `0.1`. These are proposal identifiers, not published catalog versions. The original source baseline is local commit `60c66677d939df8b1d0b59c43a1e8627f45223bc`; later local commits record the authored refinements and prototypes separately.

The existing #548 guide and standalone request/check prototype demonstrate narrower loops. The six-lesson reader makes the complete authored sequence locally usable. This package does not change the hosted application. The 32 original and 13 applied-learning BDD scenarios retain their broader scope; eight PROTO and twelve READER scenarios identify separately tested local behavior. None changes the approved application journey register.

Routine content and wording choices proceed under the owner's instruction. Production work is parked. The Everyday rehearsal produced a complete book-swap artifact and a separate repair-café final record, then drove specific content and workflow repairs. Next under #549: rehearse the Work route with substantive connected answers and inspect its owner/date/revision reasoning. Automated interaction checks do not prove learning quality. Lead Sol / High, with author self-review; coordinate canonical source or shared application reader adoption with #93/#117.
