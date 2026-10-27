# Content and learner workflows

Design for local content refinement under [#549](https://github.com/deepnative/deep-native-engine/issues/549). The behaviors below are specifications. See [traceability](traceability.md) for what has implementation or observed evidence. Publication, hosted operations and release work are parked.

## Create, try, improve

**Draft outcome → write source/example → write attempt/feedback → write transfer → editorial check → local preview → revise.**

The author starts with what the learner will do and the artifact they will keep. The author supplies all facts needed by the exercise, then writes a correct answer, plausible distractors and an explanation for each. The explanation must address the learner's choice: “The source says twelve; fifteen conflicts with it” is useful. “Incorrect, try harder” is not.

A fresh case changes the source facts and asks for the same skill. It must not be the earlier question with reordered answer letters. For free writing, the author supplies examples of acceptable reasoning and a criterion rubric; exact wording is not required.

Editorial review checks teaching quality, answer correctness, source/rights statements and the next action. Routine content decisions are delegated: they do not wait for another owner or qualified-expert approval. Existing catalog role checks remain real implementation boundaries; the author cannot pretend that their own check is a separate review. “Ready for local preview” is a working content state, not a new published catalog state.

Each requested revision names a question/paragraph, observed problem and expected improvement. Example: “L3-E-P3 treats an undecided budget as contradicted. Change the key to Not given and explain the distinction.” The author corrects the key, feedback and any transfer example affected by the same rule, then records which version changed.

If source permission is unclear, replace the exercise with an original invented equivalent or exclude the disputed material. Continue the rest of the lesson. Do not make an external rights question a blanket stop on ordinary content authoring.

Local preview should expose all three routes, wrong-answer feedback, a hint, the correct path and a distinct transfer. Feedback about the lesson enters the next draft. When adoption eventually changes a catalog version, existing submitted artifacts must stay attached to their original lesson/rubric version; do not silently regrade them. Retirement removes an item from new recommendations while retained private history describes what was used. Account/source deletion rules still take precedence over retention.

## Learn, apply, return

The proposed path entry shows a useful outcome, the learner's last saved work and one recommended next action. Learners may change their example route without changing permissions or being funnelled into a career or paid path. A goal change does not move old private writing into a different exercise.

The course has several distinct kinds of progress:

| State | What it means | What it does not establish |
| --- | --- | --- |
| Opened | The lesson was opened. | That it was read or understood. |
| Tried | An answer was attempted. | That it was correct. |
| Practised with feedback | A learner used correction or a hint. | An unaided correct answer. |
| Applied | A learner wrote or revised an artifact. | That every criterion was met. |
| Self-checked | The learner marked criteria and gave a reason. | Independent mastery or a credential. |
| Saved | Persistence was confirmed. | That a reviewer has seen the work. |

This vocabulary is proposed for the course; it is not a claim that all these states are stored today. The existing activity record already distinguishes opening, starting and self-reported completion. Reuse it where its semantics match.

On a wrong answer, keep the source and selected answer visible, explain the specific misconception and offer a hint/retry. On a correct choice, explain why it fits and offer a fresh case. A learner who opens the worked answer can continue practising; do not claim their next copied answer is an independent demonstration.

For own work, present the source/request/check as one artifact. Save confirmation is explicit. If a save fails, keep the typed work available for retry; do not show success. A returning learner gets their last saved artifact and a clear description of any unsaved or unpersisted step. Persisting question-step position is still proposed; the existing #548 guide does not promise it.

## Ask for feedback, then revise

**Private draft → choose an exact saved version → request feedback → read observation and suggestion → revise → compare → save a new version.**

The learner chooses which saved version to request feedback on. A response names the source version, the observed issue, a suggested check and its actual origin. Automated sample guidance, peer comments and formal assessment are distinct. A formal assessment is outside this package; an ordinary helpful comment does not need to impersonate one.

Example based on Lesson 3:

- **Submitted v1:** “Fifteen volunteers meet at the library.”
- **Feedback:** “E3 states twelve volunteers and leaves the venue undecided. Correct the count and mark the venue to be confirmed.”
- **Revised v2:** “Twelve volunteers are available; venue to be confirmed.”
- **Learner reason:** “I changed the count to match the source and removed the assumed venue.”

If feedback refers to v1 while v2 already fixes the problem, show the version difference and let the learner record “already addressed” with a reason. Do not overwrite v2 or attach the old comment as if it reviewed v2. If the learner disagrees, let them point to source evidence and ask for clarification; agreeing with feedback is not the only successful outcome.

Saving private work does not share it with editors or peers. A request uses the existing explicit access/grant semantics where implemented. Withdrawal stops new reviewer reads/exchanges; owner-visible previously published feedback follows the established retained-feedback rules. Unauthorised readers receive no private content. Improving a public lesson from private work requires a separately authorised example or a newly invented equivalent, not copying the learner's writing into the lesson.

## The concrete first local prototype

Build one **Lesson 2 → Lesson 3** transition with supplied invented answers: preserve the source and request; let the learner classify one supported, one contradicted and one not-given claim; show answer-specific explanation; let them write a repair and a reason. Carry the result into the existing private draft UI. The selected behavior is captured in LEARN-FLOW-006, 007 and 008 and WORK-FLOW-004.

First use a separate local reader/storyboard to evaluate the wording, then choose a bounded application issue if it works. Coordinate with the #117 reader owner before changing shared routes or canonical content. No provider call, new service, publication or production setup is required for this content experiment.

**Local checkpoint, 27 October:** the [standalone walkthrough](prototype/README.md) now demonstrates this sequence for all three routes. It keeps the request, teaching sample, correction and reason together and supports deliberate browser-local saves. Its before/after comparison uses a supplied teaching sample, not an immutable submitted member version. Account-linked saving and transfer into the existing private draft UI remain integration work. A reproduced local defect showed that edits could retain obsolete self-check marks; the prototype now clears those marks whenever the request, correction or reason changes. PROTO-008 captures that behavior.

**Content checkpoint, 27 October:** all six lessons and the [connected final practice](foundation-practice.md) are now authored. Lessons 4–6 add explicit use/share decisions, source/tool failure recovery, mistaken feedback and older-draft feedback. [APPLIED-LEARN-001–013](features/applied-learning.feature) specify those teaching outcomes; they are not application test passes. The next local reader should make the whole sequence easy to browse while preserving the existing request/check/revision walkthrough.

**Reader checkpoint, 27 October:** the [complete local reader](reader/README.md) now makes that sequence usable in all three routes. READER-001–009 cover the local interaction scope. Learners can retain earlier notes, write a connected final record, explicitly save in their browser or download it. An actual transfer-source mismatch was reproduced and corrected: the reference panel now follows the fresh exercise. Member-account persistence and canonical source adoption remain separate work.
