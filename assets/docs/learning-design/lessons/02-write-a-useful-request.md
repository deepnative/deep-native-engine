# 2. Write a useful request

**You will leave with:** a request that includes the right facts, a useful output shape, and a way to check the answer. Bring the four lines you wrote in Lesson 1, or use an example here. Allow about 10–15 minutes; no AI account is needed.

## See it

“Make these notes useful” gives the reader little guidance. Try four ingredients:

1. **Context:** only the source facts needed for this task.
2. **Task:** what to produce.
3. **Shape and limits:** how the result should be organised and what must stay unknown.
4. **Check:** how you will judge it before using it.

You do not need a magic phrase or a long prompt. These ingredients make your intention inspectable. They cannot guarantee that an answer will follow it.

### Everyday worked request

**Source E2:** Twelve volunteers, two hours on Saturday; venue and budget undecided; no start time given.

> Suggest a community activity plan for twelve volunteers and two hours on Saturday. Use a table with activity, duration and number of volunteers needed at the same time. Label proposed activities as suggestions. Keep venue and budget undecided and do not invent a start time. I will check total duration and simultaneous volunteer counts against the source before using the plan.

“At the same time” matters: twelve people can do different tasks in successive slots. Adding all staffing numbers across the afternoon would not measure simultaneous demand.

### Work worked request

**Source W2:** The process test is next Tuesday. Sam writes the checklist. Alex gathers feedback. No announcement owner or date is recorded. No checklist or feedback deadline is given.

> Turn these notes into an action table with task, owner and date columns. Keep Sam's checklist and Alex's feedback task. Include the process test on next Tuesday, with its owner not specified. Put “not specified” for other missing owners or dates. List announcement ownership and timing as open questions, not agreed actions. I will compare each row with the source before sharing it.

Here the format helps reveal uncertainty. The request does not silently assign every date to Tuesday.

### Technical worked request

**Source T2:** The sign-up form accepts email and password. It must explain invalid input without exposing whether an email already has an account. No tests have been run.

> Propose test cases for invalid input and account privacy. Use columns for sample input, expected behavior, requirement checked and execution status. Use invented addresses. Record every execution status as “not run”; do not report observed results. I will compare coverage with the requirements and run the tests separately.

This gives a reviewer something to evaluate without suggesting that a test plan proves the form works.

## Repair a request

Choose the missing instruction that would most improve each request. Work only on your selected route first.

### Everyday question — `L2-E-P`

The request says: “Suggest a two-hour plan for twelve volunteers on Saturday. Use activity and duration columns.” What should you add?

- **A.** Use the library as the venue because it sounds suitable.
- **B.** Make the plan enthusiastic and do not mention uncertainty.
- **C.** Keep venue, budget and start time unconfirmed; add simultaneous volunteer counts so I can check the limits.

**Hint:** Improve what you can inspect, and protect the missing facts.

<details><summary>Check your answer</summary>

**C adds the useful missing constraints.** **A** converts a possible venue into a fact. **B** could hide a gap behind tone. Enthusiasm can be a preference, but it cannot replace a check of people, time and unknown details.

</details>

### Work question — `L2-W-P`

The request says: “Turn Source W2 into task, owner and date columns.” What should you add?

- **A.** Give each task next Tuesday as its date.
- **B.** Use “not specified” when a task's owner or date is missing, and compare each row with the notes.
- **C.** Fill missing owners from whichever person's name appears closest.

**Hint:** Which dates and owners does the note actually attach to each task?

<details><summary>Check your answer</summary>

**B preserves the source.** **A** reuses the process test date for unrelated deadlines. **C** treats word proximity as authority to assign work. If your draft has either error, replace that owner or date with “not specified” and record an open question.

</details>

### Technical question — `L2-T-P`

The request says: “Create sign-up tests with input and expected behavior.” What should you add?

- **A.** Link each case to the supplied requirement and mark execution “not run.”
- **B.** Add “passed” for cases whose expected behavior is easy to describe.
- **C.** Predict that the form passes because it has email and password fields.

**Hint:** A clear expectation is useful before execution, but is still an expectation.

<details><summary>Check your answer</summary>

**A makes coverage and evidence inspectable.** **B** invents test outcomes. **C** infers correct behavior from field names. Keep the expected result, then use a separate status to say what has actually been observed.

</details>

## Try a fresh case

Write a two-to-four-sentence request using one of these sources. Include all four ingredients; no exact wording is required.

| Case | Fresh source |
| --- | --- |
| `L2-E-X` | A seed-swap table has six helpers and forty seed packets. It opens on Sunday for one hour. The location and start time are undecided. |
| `L2-W-X` | Mina drafts a survey. Arun checks the wording. A trial is planned for Thursday. No survey deadline, review deadline or launch date is agreed. |
| `L2-T-X` | A contact form requires an email and message. A blank message must show an explanation. No maximum message length is specified. No tests have been run. |

<details><summary>Compare with a worked request</summary>

- **Everyday:** “Draft a short invitation to a one-hour seed swap on Sunday, with six helpers and forty packets available. Keep location and start time to be confirmed. I will check every number and avoid promising a packet to everyone, since attendance is unknown.”
- **Work:** “Make a task/owner/date table for Mina's survey, Arun's wording check and Thursday's trial. Keep unagreed owners and dates not specified; list the launch date as an open question. I will compare each row with the notes.”
- **Technical:** “Propose cases for the required email and message, including a blank message. List input, expected behavior, source requirement and execution status, using not run. Keep maximum length unspecified. I will check requirement coverage before executing the cases.”

An answer is ready for the next step when the facts remain correct, the output can be inspected, uncertainty is visible and the check could catch an error. If your wording differs but achieves these, keep it. If it adds an unagreed date, place or limit, remove that invention.

</details>

## Improve your own request

Take your Lesson 1 task. Write the request, then annotate it with **context / task / shape and limits / check**. If one ingredient is absent, add just the sentence needed.

**Self-check rubric:**

| Criterion | What you should be able to point to | If it is missing |
| --- | --- | --- |
| Faithful context | Each included number, name or commitment appears in your source. | Remove or clearly label the extra detail as a suggestion. |
| Useful task | One draft output is named. | Replace “help me” with the draft you want. |
| Inspectable shape and limits | A reader can tell how to organise it and what not to guess. | Add columns, a short outline or explicit unknowns. |
| Meaningful check | You name what you will compare with which source. | Replace “check quality” with a specific check. |

Keep the source beside the request. Save the version you want to work from; checking every box does not certify the answer an AI might produce.

**Take forward:** [Lesson 3: Check an answer](03-check-an-answer.md) gives you a flawed answer to inspect, so you can practise even without calling an AI tool.

<!-- Author reference: draft LD-FND-002 0.2; refines FND-002. Original synthetic examples. Question IDs are content IDs, not automated tests. -->
