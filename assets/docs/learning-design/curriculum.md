# A foundation that produces useful work

Draft for [#549](https://github.com/deepnative/deep-native-engine/issues/549), 27 October 2026. Three complete lessons are authored here; the remaining three have outcome and exercise briefs, not finished teaching scripts. This proposal refines the existing FND sequence and keeps its identifiers.

The learner builds one small artifact over the sequence: **source → task → request → checked answer → sharing decision → repeatable workflow → helpful feedback**. Each lesson adds something the learner can inspect. Coding, employment, a paid plan and a live AI provider are not prerequisites.

| Existing ID / proposed lesson | After this lesson, the learner can… | Prerequisite | Work to keep | Next action |
| --- | --- | --- | --- | --- |
| FND-001 / [Choose a task you can check](lessons/01-choose-a-checkable-task.md) | Name one draft task and a check that could reveal a mistake. | None; choose or reuse an invented source. | Source, task, check, missing detail. | Turn the task into a request. |
| FND-002 / [Write a useful request](lessons/02-write-a-useful-request.md) | Include relevant facts, an output shape, limits and a meaningful check. | A task from Lesson 1 or its worked example. | Annotated request and source. | Inspect a supplied flawed answer. |
| FND-003 / [Check an answer](lessons/03-check-an-answer.md) | Separate supported, contradicted and not-given claims; repair a draft with reasons. | A source and request from Lesson 2 or its worked example. | Claim table, corrected answer and revision reason. | Decide what information can be used or shared. |
| FND-004 / Choose what to use and share | Replace unnecessary personal details and choose an audience deliberately. | Any draft artifact; Lesson 3 gives one. | Invented sample plus use/share decision. | Put the draft and check into a repeatable process. |
| FND-005 / Build a repeatable workflow | Specify input, draft, check, decision and recovery for a small recurring task. | Request/check habit from Lessons 2–3. | Five-step workflow with a stop/recovery condition. | Ask for focused feedback on one step. |
| FND-006 / Give feedback someone can use | Point to evidence, suggest one check and revise work without treating a peer comment as a formal grade. | A sample and sharing choice; worked examples remain available. | Feedback note, revised version and reason. | Repeat the workflow with a new sample. |

Suggested lesson sizes are 8–15 minutes for the three drafted lessons. They are author estimates, not measured completion times. Learners can leave, return, or revisit an example without losing credit or being punished for a mistake.

## The remaining lesson briefs

**FND-004:** show an invented volunteer contact sheet. Ask whether a schedule needs phone numbers. A good answer keeps volunteer counts and roles and replaces real identifiers with invented labels. Transfer to meeting notes or logs. Distinguish “I can read this” from “I may send this to that tool/person.” The finished exercise names input, audience and purpose; a private save alone creates no sharing request.

**FND-005:** use the corrected Lesson 3 answer to build input → draft → check → decision → recovery. Give a draft with one unsupported date and a second case where the source cannot be opened. The learner must say what remains usable, what needs clarification and what they will do next. An acceptable process keeps the source, avoids sending an unchecked draft and names a recovery action.

**FND-006:** compare “This is bad” with “The source leaves the date open; mark it unknown and ask the organiser.” The learner writes one observation, one suggested check and one limit. A fresh case contains feedback about an older version. The learner must compare it with the current version, record a reason for accepting or declining it and save a new version without rewriting the earlier submission.

These briefs require full worked examples, answer keys and transfer cases before they become authored lessons. They do not imply the current application renders this sequence.

## What changes from the inspected baseline

Baseline: original FND v1 Markdown at local commit `60c66677d939df8b1d0b59c43a1e8627f45223bc`, plus the #548 guided first lesson at that commit. The six originals already cover useful themes and three audience routes. This package adds a continuous learner artifact, explicit examples, diagnostic wrong answers, distinct transfer tasks and observable self-check criteria.

The #548 guide already demonstrates example → choice → explanation → transfer → private writing for three goals. It does not implement this three-lesson curriculum or persisted question-by-question resume. Existing completed exercises are self-reported, not independently demonstrated mastery.

Another worker retains the canonical source/reader claims in [#93](https://github.com/deepnative/deep-native-engine/issues/93) and [#117](https://github.com/deepnative/deep-native-engine/issues/117). Their prepared revisions were not substituted into this baseline. Reconcile exact versions before adopting these proposals; do not overwrite their work or judge their newer drafts from this older checkout.

## A manageable learning loop

```text
Choose an example → See a worked case → Try → Explain the result
                                              ↓
                             Hint / correct ← Needs another try
                                              ↓
                         Fresh case → Make your own → Save / reflect
                                              ↓
                                        Next lesson
```

At each step the primary action says what happens: **Try this**, **Check answer**, **Try again**, **Try a fresh case**, **Save draft**, **Continue to…**. Source text stays available. Correctness feedback refers to the chosen answer and source. A learner can inspect an example answer, but the record must not call that an unaided attempt.

This is a proposed course-wide interaction contract. The [traceability](traceability.md) identifies the narrower existing behavior. No points, streaks, leaderboards, time pressure or automatic proficiency score are needed to teach these outcomes.

## How to assess the content in a local walkthrough

Use the three supplied routes before adding more material. Ask a participant to choose a task, revise one weak request, identify a contradicted and a not-given claim, then repair a fresh answer. Observe the work produced and where the instructions fail them. Do not infer comprehension from page views or word counts.

For each confusing moment, record the question ID/version, the interpretation, the expected reasoning and a candidate improvement. Use invented or explicitly provided samples; keep observations local. These are proposed observation prompts, not collected analytics or claims about real learners.
