# Learn by making something useful

A local content and workflow draft for [#549](https://github.com/deepnative/deep-native-engine/issues/549), prepared 27 October 2026. **Start with a lesson below.** These are written lessons with worked examples and feedback; the course-wide interactions are specified separately in BDD.

| Read as a learner | What you will make |
| --- | --- |
| [1. Choose a task you can check](lessons/01-choose-a-checkable-task.md) | A small task, its source and a check. |
| [2. Write a useful request](lessons/02-write-a-useful-request.md) | A request with facts, output shape, limits and a check. |
| [3. Check an answer](lessons/03-check-an-answer.md) | A claim-by-claim review and a corrected answer. |

Each lesson offers Everyday, Work and Technical routes. Choose one rather than reading all three. Every route has supplied facts, a worked example, a practice attempt, specific feedback, a fresh case and an own-work self-check. Learners can use the invented samples throughout, without an AI account.

The three drafts form the first half of the [six-lesson map](curriculum.md). Lessons 4–6 currently have outcome/exercise briefs; their full scripts remain to be written. These proposals live separately from the canonical FND files owned by the ongoing #93/#117 work.

## What the study changes

Khan Academy describes its revised learning experience around clear next steps, meaningful practice and timely feedback. Our design uses one recommended next action and keeps the source beside the attempt. [Khan Academy's classroom experience](https://blog.khanacademy.org/meet-the-new-khan-academy-classroom-experience/).

Duolingo describes starting with simpler exercises, moving to new contexts, and offering hints and short explanations. Its answer-explanation feature addresses the learner's particular mistake. Our design uses a worked example, answer-specific feedback and a fresh case before the learner applies the skill to their own artifact. [Duolingo teaching method](https://blog.duolingo.com/duolingo-teaching-method/), [answer explanations](https://blog.duolingo.com/explain-my-answer-now-free/).

These are design interpretations of their published approaches, not evidence that our drafts achieve the same learning results. All lesson text and cases here are original synthetic material. No competitor lesson, illustration or branded interface is copied. Official sources were checked on 27 October 2026; feature availability can vary by course/account.

## Inspect the behavior

- [Content and learner workflows](workflows.md): author → check → preview → refine; learner → attempt → correction → application; feedback → revision.
- [Content refinement BDD](features/content-refinement.feature): 11 scenarios, including incorrect answer keys, source uncertainty and version changes.
- [Learner journey BDD](features/learner-journey.feature): 14 scenarios, including hints, save/resume, goal changes and honest progress.
- [Feedback and revision BDD](features/feedback-revision.feature): 7 scenarios, including exact-version feedback, clarification, revision and recovery.
- [Evidence and acceptance map](traceability.md): all 32 scenarios, with existing, partial and proposed behavior separated.

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

Authored drafts: `LD-FND-001`, `LD-FND-002`, `LD-FND-003`, each revision `0.1`, corresponding to FND-001 through FND-003. These are proposal identifiers, not new published catalog versions. The source baseline is local commit `60c66677d939df8b1d0b59c43a1e8627f45223bc`.

The existing #548 local guide demonstrates a narrower example/practice/transfer/writing loop. This package does not change the application or make these three new lessons available on the hosted site. The BDD files are specifications, not executed automated tests, and they do not alter the approved journey register.

Routine content and wording choices proceed under the owner's instruction. Production publication, release verification campaigns, merges, deployments and hosted setup are parked. The next bounded content experiment is the [Lesson 2 → Lesson 3 local prototype](workflows.md), using supplied answers and the existing private-writing behavior. Coordinate shared reader changes with #117 first; lead recommendation: Sol / High, with author self-review. A separate review is only required if explicitly requested or imposed by the selected implementation scope.
