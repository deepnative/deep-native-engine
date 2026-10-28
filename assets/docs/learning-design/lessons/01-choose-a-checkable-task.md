# 1. Choose a task you can check

**You will leave with:** one small task, the information it uses, and a clear way to check the result. Allow about 8–12 minutes; this is an estimate, not a timer. No AI account is needed.

Choose Everyday, Work or Technical examples below. You can change examples at any time. The skill is the same: give a tool a task whose result you can judge.

## See it

Imagine asking someone to “organise a great event.” They would need to guess what matters to you. A smaller request is easier to check: “Draft a plan using these people and this time. Leave undecided details open.”

A useful starting task has three parts:

1. **Source:** information you can point to.
2. **Draft:** one useful thing to produce.
3. **Check:** something observable that would make you keep or change it.

The draft may suggest a new idea. It must identify that idea as a suggestion rather than turn it into an agreed fact.

### Everyday — plan a community activity

**Source E1:** Twelve volunteers are available for two hours on Saturday. The venue and budget are undecided.

**Worked task:** Draft a two-hour activity plan. Treat activities as suggestions; leave venue and budget undecided. I will check the schedule totals no more than two hours and no time slot needs more than twelve volunteers.

That check is stronger than “make it realistic.” You can count people and minutes. You cannot yet check a venue booking because none is supplied.

### Work — organise meeting actions

**Source W1:** A team will test a new process next Tuesday. Sam will write the checklist. Alex will gather feedback. No announcement owner or date is recorded.

**Worked task:** Draft an action table from the notes. I will compare each task, owner and date with the note. A missing owner or date stays “not specified.”

Next Tuesday is the process test date. It is not automatically a deadline for every other action.

### Technical — prepare test cases

**Source T1:** A sample sign-up form takes email and password. It must explain invalid input without revealing whether an email already has an account. No tests have been run.

**Worked task:** Draft candidate tests for invalid input and account privacy. I will check that each case names an input and expected result tied to a requirement. Every execution status stays “not run.”

Writing a test idea and running a test produce different evidence.

## Try it

Pick the best starting task for your example. Make your choice before opening the feedback. The other choices are plausible requests, but need information or evidence that is missing.

### Everyday question — `L1-E-P`

- **A.** Draft a two-hour plan for twelve volunteers at the library; check minutes and staffing against E1.
- **B.** Draft a two-hour plan for twelve volunteers; check minutes and staffing, leaving venue and budget open.
- **C.** Draft a two-hour plan for twelve volunteers; check attendance by adding staff counts across its sequential activities.

**Hint:** Check both the facts the task assumes and what its proposed check would measure.

<details><summary>Check your answer</summary>

**B keeps the task within E1.** It gives you people and minutes to check without settling the unknown arrangements. **A:** The library is not established by E1; remove that assumed venue or label it as a suggestion needing confirmation. **C:** Adding staff counts across sequential slots can count the same person more than once. Compare each slot's demand with twelve, rather than treating the sum as attendance.

</details>

### Work question — `L1-W-P`

- **A.** Draft task, owner and date rows; check each against W1 and leave missing fields open.
- **B.** Draft task, owner and date rows; use Tuesday for every date, then check the owner names.
- **C.** Draft task, owner and date rows; use Alex for the announcement and check all the dates.

**Hint:** An owner check and a date check can catch different assumptions in the same table.

<details><summary>Check your answer</summary>

**A preserves W1's separate commitments.** Check each filled cell against the note and retain the gaps. **B transfers the trial date** to other tasks; Tuesday belongs to the process test, not every deadline. **C assigns Alex a task** the note does not give: Alex gathers feedback, while announcement ownership is open. Repair the unsupported cell without deleting the known task.

</details>

### Technical question — `L1-T-P`

- **A.** Draft a privacy report; use the stated requirement to mark those checks passed.
- **B.** Draft invalid-input cases; treat account privacy as covered by the same checks.
- **C.** Draft cases with inputs and expected behavior; check T1 and record not run.

**Hint:** Look separately for requirement coverage and evidence of execution.

<details><summary>Check your answer</summary>

**C produces candidate cases** you can compare with T1 while keeping execution not run. **A treats a requirement as an execution result**; replace passed with not run until there is actual test evidence. **B assumes invalid-input cases also cover account privacy.** A helpful error could still reveal an existing account, so include a case that checks that separate requirement.

</details>

## Try a fresh case

Choose the matching route. Write one task and one check before opening the example. There can be more than one useful answer.

| Case     | Fresh source                                                                                                                        | Your task                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `L1-E-X` | A book swap has eight helpers and thirty donated books. It is free, on Sunday afternoon. The location is unconfirmed.               | Choose a draft you can check without inventing a location. |
| `L1-W-X` | Jo will collect three comments after a Wednesday pilot. Rene will update the instructions. The continuation decision date is unset. | Choose a useful output and one source-based check.         |
| `L1-T-X` | An upload form should accept PDFs up to 2 MB and explain rejected input. No tests have been run.                                    | Choose a useful testing task that does not claim a result. |

<details><summary>Compare your approach</summary>

- **Everyday:** “Draft an invitation. Check it says free and Sunday afternoon, and keeps the location to be confirmed.” A named library would need confirmation first.
- **Work:** “Draft an action table. Check Jo's task is three comments and the continuation date stays unset.” Wednesday does not supply that decision date.
- **Technical:** “Propose a case for a 3 MB PDF. Check the expected rejection against the size rule; record the test as not run.” The requirement supports an expectation, not an observed failure.

If your answer uses a different output, keep it when the source supports it and the check can reveal a mistake. If you reused “make it good,” replace that phrase with a check of a number, claim or missing fact.

</details>

## Make something of your own

Use invented details, or reuse a source above. Keep this private while practising.

> My source: …
>
> My one draft task: …
>
> I will check … against …
>
> The missing detail I will leave open is …

**Self-check:** Can you point to a source? Is the requested result one manageable draft? Could your check catch a specific mistake? Is a missing detail still visible? If one answer is no, revise that line. A long answer is not automatically a good answer.

**Take forward:** keep these four lines for [Lesson 2: Write a useful request](02-write-a-useful-request.md). You will turn them into instructions someone else can follow.

<!-- Author reference: draft LD-FND-001 0.3; refines FND-001, does not replace its canonical version. Original synthetic examples. Question IDs are content IDs, not automated tests. -->
