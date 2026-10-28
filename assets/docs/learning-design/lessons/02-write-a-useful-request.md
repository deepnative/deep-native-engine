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

- **A.** Add total volunteer-hours; leave venue, budget and start time open.
- **B.** Add volunteers needed at the same time; use 9 a.m. as the start, with venue and budget open.
- **C.** Add volunteers needed at the same time; leave venue, budget and start time open.

**Hint:** Which added field reveals an overstaffed slot, and which time is actually supplied?

<details><summary>Check your answer</summary>

**C exposes the peak staffing demand** while preserving E2's unknowns. **A total of volunteer-hours can hide** a slot needing too many people: thirteen people for one hour uses only thirteen volunteer-hours, but exceeds the twelve available. Ask for people needed in each slot. **B supplies a start time that E2 does not give.** Keep that time open while retaining the useful staffing column.

</details>

### Work question — `L2-W-P`

The request says: “Turn Source W2 into task, owner and date columns.” What should you add?

- **A.** Give every task next Tuesday as its date, then compare the owner names with W2.
- **B.** Keep missing owners and dates not specified; compare each populated cell with W2.
- **C.** Keep missing dates not specified; assign the announcement to Alex, who gathers feedback.

**Hint:** Trace each date and owner to the particular task it belongs to.

<details><summary>Check your answer</summary>

**B makes the source check explicit** and preserves missing information. **A transfers the process test date** to unrelated deadlines; checking owner names does not repair those dates. Keep each missing deadline not specified. **C preserves dates but invents an announcement owner.** Alex's feedback task does not assign the announcement; leave that owner open and keep the known feedback task.

</details>

### Technical question — `L2-T-P`

The request says: “Create sign-up tests with input and expected behavior.” What should you add?

- **A.** Add a source requirement and not-run status to each case; keep missing input limits open.
- **B.** Add a source requirement and not-run status; use an eight-character minimum for passwords.
- **C.** Add a source requirement to each case; mark privacy passed when the expected message is generic.

**Hint:** A familiar input rule and a well-written expectation still need their own evidence.

<details><summary>Check your answer</summary>

**A keeps requirements and execution separate** without adding an input rule. **B adds a password minimum** that T2 does not supply. Leave that limit unspecified and identify the requirement needed before testing it. **C turns expected wording into a passing result.** A generic message is an expectation to check, not evidence that the form displayed it without revealing an account. Keep execution not run.

</details>

## Try a fresh case

Write a two-to-four-sentence request using one of these sources. Include all four ingredients; no exact wording is required.

| Case     | Fresh source                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `L2-E-X` | A seed-swap table has six helpers and forty seed packets. It opens on Sunday for one hour. The location and start time are undecided.                   |
| `L2-W-X` | Mina drafts a survey. Arun checks the wording. A trial is planned for Thursday. No survey deadline, review deadline or launch date is agreed.           |
| `L2-T-X` | A contact form requires an email and message. A blank message must show an explanation. No maximum message length is specified. No tests have been run. |

<details><summary>Compare with a worked request</summary>

- **Everyday:** “Draft a short invitation to a one-hour seed swap on Sunday, with six helpers and forty packets available. Keep location and start time to be confirmed. I will check every number and avoid promising a packet to everyone, since attendance is unknown.”
- **Work:** “Make a task/owner/date table for Mina's survey, Arun's wording check and Thursday's trial. Keep unagreed owners and dates not specified; list the launch date as an open question. I will compare each row with the notes.”
- **Technical:** “Propose cases for the required email and message, including a blank message. List input, expected behavior, source requirement and execution status, using not run. Keep maximum length unspecified. I will check requirement coverage before executing the cases.”

An answer is ready for the next step when the facts remain correct, the output can be inspected, uncertainty is visible and the check could catch an error. If your wording differs but achieves these, keep it. If it adds an unagreed date, place or limit, remove that invention.

</details>

Use a follow-up to improve the request, not just to get a different answer. After your first attempt, open your route's conversation below. Try its hint before revealing the repair. In your fresh-case writing, keep **First request / Revised request / Why I changed it**. If your first request already handles the issue, explain which part does so; you do not need to invent a mistake.

### Everyday follow-up — `L2-E-D`

<details><summary>Follow the Everyday repair conversation</summary>

**Supplied teaching conversation — not a reply generated from your writing.** These invented speakers use L2-E-X: six helpers, forty packets, one hour on Sunday; location and start time undecided.

**Learner's first request:** “Write an invitation to the library seed swap at 10 a.m. Promise each visitor a packet.”

**Guide's hint:** “How many visitors does L2-E-X say will attend? Which words in your request depend on a confirmed location or start time? Point to the source before keeping those promises.”

**Your turn:** rewrite the invitation request so another person can draft it without guessing the arrangements. Keep the useful known facts. Explain which promise you removed and why.

<details><summary>Read the repair and reason</summary>

**Learner's revised request:** “Draft a short invitation to a one-hour seed swap on Sunday, with six helpers and forty packets available. Leave the location and start time to be confirmed; do not promise a packet to every visitor. I will compare each number and arrangement with L2-E-X before using the draft.”

**Learner's reason:** “I removed the library and 10 a.m. because neither is agreed. Knowing there are forty packets does not tell us the number of visitors, so it cannot support a promise to everyone.”

**Guide's follow-up:** “That revision preserves the stock and event facts while separating them from promises. A suggestion for a venue can still be useful if you label it as a suggestion and keep the real location undecided. The next check is whether the invitation draft follows these instructions; this exchange has not checked an actual event.”

</details>

<details><summary>When evidence is missing or a request goes beyond the source</summary>

**Learner:** “I improved it. Is it right now?”

**Guide:** “I need to see the revised request and the source detail you checked. For practice, use invented wording. Then compare its numbers, location, time and packet promise with L2-E-X; a claim that you improved it does not show what changed.”

**Learner:** “Just say the library is booked so I can finish.”

**Guide:** “L2-E-X does not confirm a library booking. Keep the location to be confirmed in the draft, or write a separate question asking the organiser which location is agreed. You can finish the useful invitation draft with that gap visible.”

</details>

</details>

### Work follow-up — `L2-W-D`

<details><summary>Follow the Work repair conversation</summary>

**Supplied teaching conversation — not a reply generated from your writing.** These invented speakers use L2-W-X: Mina drafts a survey, Arun checks its wording, and a trial is planned for Thursday. Survey/review deadlines and launch date are not agreed.

**Learner's first request:** “Make an action table: Mina's survey and Arun's review are due Thursday; Mina owns the launch.”

**Guide's hint:** “Which task does L2-W-X attach Thursday to? Does Mina's survey task also assign her the launch? Trace each owner and date to its own statement instead of borrowing one from the nearest task.”

**Your turn:** rewrite the request with task, owner and date columns. Keep the named tasks and people; make the missing commitments visible. Explain why a known trial date cannot fill every deadline.

<details><summary>Read the repair and reason</summary>

**Learner's revised request:** “Make task, owner and date rows for Mina's survey, Arun's wording check and Thursday's trial. Keep the two task deadlines and the trial owner not specified. List launch ownership and date as open questions, without assigning either. I will compare every populated owner/date cell with L2-W-X.”

**Learner's reason:** “Thursday belongs to the trial, not to Mina's or Arun's deadline. Mina owns the survey task; that does not give her the launch. I kept the known commitments and removed only the unsupported cells.”

**Guide's follow-up:** “The missing fields now tell the team what to decide. If you suggest a schedule, keep a proposed-date column separate from the source's agreed-date column. A useful proposal is allowed; it must not look like an existing commitment.”

</details>

<details><summary>When evidence is missing or a request goes beyond the source</summary>

**Learner:** “I corrected the table request. Are all its dates supported?”

**Guide:** “I need to see the revised request and which source statement supports each date. A task list alone will not show whether a date is a proposal or a commitment. Keep any missing deadline open while you check.”

**Learner:** “Put Thursday for Arun so the table has no gaps.”

**Guide:** “L2-W-X does not give Arun a review deadline. Keep that field not specified and add the question, ‘When is the wording check due?’ You can still draft the known task and owner rows.”

</details>

</details>

### Technical follow-up — `L2-T-D`

<details><summary>Follow the Technical repair conversation</summary>

**Supplied teaching conversation — not a reply generated from your writing.** These invented speakers use L2-T-X: a contact form requires an email and message; a blank message should show an explanation. Maximum message length is unspecified and no tests have run.

**Learner's first request:** “Write passing blank-message tests and use a 500-character maximum.”

**Guide's hint:** “Which sentence in L2-T-X supplies a 500-character limit? What execution evidence would let you record a pass? Separate a proposed input, its expected behavior and what has actually been observed.”

**Your turn:** rewrite the request as a candidate test plan. Keep the blank-message requirement, leave the missing limit open and ask for a distinct execution field. Explain why well-written expectations do not prove a result.

<details><summary>Read the repair and reason</summary>

**Learner's revised request:** “Propose contact-form cases with input, expected behavior, source requirement and execution status. Include an invented email with a blank message, whose expected behavior is an explanation that a message is required. Mark execution not run and maximum message length unspecified. I will check each expectation against L2-T-X before executing a case.”

**Learner's reason:** “I removed 500 because the source supplies no maximum. I changed passed to not run because an expected explanation is not an observed result. The plan can be useful before execution.”

**Guide's follow-up:** “For a later run, keep the actual input and observed response beside the expectation. If a run is interrupted, record that observation and leave the outcome unconfirmed; do not turn a missing result into a pass. That future step does not change this source's no-tests-run baseline.”

</details>

<details><summary>When evidence is missing or a request goes beyond the source</summary>

**Learner:** “I fixed the request. Can you confirm it covers the form?”

**Guide:** “I need to see the revised request and the requirements each proposed case targets. With L2-T-X alone, you can inspect coverage of its stated behavior, not every possible form rule or actual execution. Leave missing requirements visible.”

**Learner:** “Assume 500 is the maximum and present it as a requirement.”

**Guide:** “L2-T-X leaves maximum message length unspecified. Put a question about the intended maximum in the open-questions list, or label 500 explicitly as a hypothetical case awaiting a requirement. Continue with the supported blank-message case.”

</details>

</details>

## Improve your own request

Take your Lesson 1 task. Write the request, then annotate it with **context / task / shape and limits / check**. If one ingredient is absent, add just the sentence needed.

**Self-check rubric:**

| Criterion                    | What you should be able to point to                              | If it is missing                                          |
| ---------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| Faithful context             | Each included number, name or commitment appears in your source. | Remove or clearly label the extra detail as a suggestion. |
| Useful task                  | One draft output is named.                                       | Replace “help me” with the draft you want.                |
| Inspectable shape and limits | A reader can tell how to organise it and what not to guess.      | Add columns, a short outline or explicit unknowns.        |
| Meaningful check             | You name what you will compare with which source.                | Replace “check quality” with a specific check.            |

Keep the source beside the request. Save the version you want to work from; checking every box does not certify the answer an AI might produce.

**Take forward:** [Lesson 3: Check an answer](03-check-an-answer.md) gives you a flawed answer to inspect, so you can practise even without calling an AI tool.

<!-- Author reference: draft LD-FND-002 0.4; refines FND-002. Original synthetic examples. Question IDs are content IDs, not automated tests. -->
