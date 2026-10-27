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

- **A.** Draft a plan for the library booking and confirm the $200 budget.
- **B.** Draft a schedule within two hours and twelve volunteers; mark venue and budget undecided.
- **C.** Write a cheerful plan; keep it if the wording sounds confident.

**Hint:** Which option gives you a check you can actually perform with Source E1?

<details><summary>Check your answer</summary>

**B is the best starting task.** It uses the supplied limits and names what is missing. **A** assumes a library booking and budget that the source never gives. **C** checks tone, but a confident plan could still require twenty people. The two-hour total and twelve-person limit give you concrete checks.

</details>

### Work question — `L1-W-P`

- **A.** Draft an action table, preserve missing owners and dates, and compare every row with the notes.
- **B.** Give every action a deadline so the table has no blank information.
- **C.** Announce that Alex will deliver the final results on Friday.

**Hint:** A complete-looking table can contain invented commitments.

<details><summary>Check your answer</summary>

**A is best.** It produces something useful without deciding for the team. **B** fills gaps with commitments the team did not make. **C** changes Alex's task and invents Friday. “Not specified” is useful information: it tells the team what to decide next.

</details>

### Technical question — `L1-T-P`

- **A.** Report that the sign-up form is secure because a privacy requirement exists.
- **B.** List some tests and mark them passed to show the plan is complete.
- **C.** Draft test cases, link each to a requirement, and leave results “not run.”

**Hint:** What evidence would be needed to report an observed result?

<details><summary>Check your answer</summary>

**C is best.** You can check a proposed test against the requirements now. **A** confuses intended behavior with observed behavior. **B** records a result without executing a test. Correct either by separating the proposed case from its execution status.

</details>

## Try a fresh case

Choose the matching route. Write one task and one check before opening the example. There can be more than one useful answer.

| Case | Fresh source | Your task |
| --- | --- | --- |
| `L1-E-X` | A book swap has eight helpers and thirty donated books. It is free, on Sunday afternoon. The location is unconfirmed. | Choose a draft you can check without inventing a location. |
| `L1-W-X` | Jo will collect three comments after a Wednesday pilot. Rene will update the instructions. The continuation decision date is unset. | Choose a useful output and one source-based check. |
| `L1-T-X` | An upload form should accept PDFs up to 2 MB and explain rejected input. No tests have been run. | Choose a useful testing task that does not claim a result. |

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

<!-- Author reference: draft LD-FND-001 0.2; refines FND-001, does not replace its canonical version. Original synthetic examples. Question IDs are content IDs, not automated tests. -->
