# 5. Build a small repeatable workflow

**You will leave with:** a five-step workflow you could repeat with a new sample, including what to do when a draft or source fails. Bring your source, request, checked answer and use-and-share note, or use one of the invented cases below. Allow about 15 minutes. You can complete the whole exercise on paper.

## See it

A repeatable workflow explains more than how to get a draft. It explains how a person knows whether that draft is useful and what happens next.

| Step | Question it answers |
| --- | --- |
| **Input** | What source am I using, what may be missing, and is it suitable for this purpose? |
| **Draft** | What small output will I create? |
| **Check** | What observable comparison could catch an error? |
| **Decision** | Will I keep, revise or set aside the draft, and for which use? |
| **Recovery** | What will I do if the source is missing, the draft is wrong or the tool fails? |

Make each step something someone could actually do. “Check carefully” leaves the important work unexplained. “Add the durations and compare the total with sixty minutes” tells you how to check.

### Everyday — fit a plan to the people and time

**Source E5:** A fictional seed swap has six helpers available throughout one hour on Sunday and forty seed packets. Location and start time are undecided. You are making an internal planning draft, not a final public invitation.

**Draft to inspect:**

| Sequential activity | Minutes | Helpers needed at that time |
| --- | --- | --- |
| Set up | 10 | 2 |
| Swap | 45 | 7 |
| Tidy | 10 | 3 |

**Worked check:** 10 + 45 + 10 = 65 minutes, which exceeds sixty. The swap also needs seven helpers when only six are available. Adding 2 + 7 + 3 is not the staffing check: the activities happen one after another, so people can take different roles in successive slots.

**Repaired draft:** setup 10 minutes with two helpers; swap 40 minutes with six; tidy 10 minutes with three. The total is sixty and the highest simultaneous demand is six. These are proposed activities, not new facts about what the group has agreed.

**Worked workflow:** use E5 → draft a sequential schedule → add minutes and check each slot's helper count → keep the repaired plan for internal discussion → if a check fails, revise the relevant slot; if the venue is still missing, preserve that open decision. The plan can be useful while a final invitation still needs confirmed details.

### Work — keep each commitment attached to its source

**Source W5:** Mina drafts a survey. Arun checks the wording. The trial is Thursday. Survey and review deadlines and the trial owner are not specified. The output is for the internal team's planning discussion.

**Draft to inspect:** “Mina delivers the survey Wednesday. Arun reviews Wednesday. Mina owns Thursday's trial.”

**Worked check:** the source supports Mina's survey task, Arun's wording check and the Thursday trial. It supplies neither Wednesday deadline nor Mina as trial owner.

**Worked workflow:** retain W5 → draft task/owner/date rows → compare every populated cell with the source → keep the supported facts and replace the invented commitments with “not specified” → ask the team about those particular gaps if an agreed schedule is needed. A missing deadline does not require throwing away the known task owner.

### Technical — separate a test idea from its execution

**Source T5:** A contact form requires an email and message. A blank message must show an explanation. No maximum message length is specified. No test has been run.

**Worked draft:** “Input: invented email, blank message. Expected: explain that a message is required. Requirement: blank-message rule. Execution: not run.”

**Worked workflow:** retain T5 → draft candidate cases → compare expectations with the requirements and check every execution status → keep a usable test plan without calling it a passing result → if the drafting tool fails, write this small case manually or retry from the retained source. If execution later fails or is interrupted, record what actually happened; do not fill a blank result with “passed.”

## Decide what to repair

### Everyday question — `L5-E-P`

Which change fixes both problems in the first schedule?

- **A.** Shorten tidy-up to five minutes, leaving seven helpers on the swap.
- **B.** Make the swap forty minutes with six helpers, leaving setup and tidy-up at ten minutes each.
- **C.** Change the source to say seven helpers are available because the draft needs them.

**Hint:** There are two checks: total time and the demand in each time slot.

<details><summary>Check your answer</summary>

**B passes both checks:** 10 + 40 + 10 = 60, and no slot needs more than six helpers. **A** fixes the duration but leaves the staffing conflict. **C** changes a source fact to suit the output. Keep the constraint and revise the proposal instead.

</details>

### Work question — `L5-W-P`

Which checking rule produces a faithful action table from W5?

- **A.** Use Thursday for every task, so every row has a date.
- **B.** Assign unowned tasks to the person named closest to them.
- **C.** Trace each owner and date to its own source statement; keep absent commitments “not specified.”

**Hint:** A filled cell can look useful while containing a decision nobody made.

<details><summary>Check your answer</summary>

**C catches the invented deadlines and trial owner.** **A** turns a trial date into unrelated deadlines. **B** turns text position into task assignment. Keep the known commitments and list only the unresolved cells as questions.

</details>

### Technical question — `L5-T-P`

Your drafting tool stops before returning a complete test plan. What can you do next with T5?

- **A.** Keep the source, write or retry the missing case, and leave execution “not run.”
- **B.** Mark the plan passed so the interrupted attempt does not block progress.
- **C.** Invent a maximum length and continue as though it were a requirement.

**Hint:** Failure to produce a draft does not change the source or create execution evidence.

<details><summary>Check your answer</summary>

**A preserves useful work and gives you a recovery step.** **B** turns a drafting failure into an invented test result. **C** adds a requirement you cannot trace. Retry or draft manually within the same facts; leave the unknown length visible.

</details>

## Try a fresh case

Write the check, decision and recovery for one route. Keep the original source separate from the proposed repair.

| Case | Fresh source and problem |
| --- | --- |
| `L5-E-X` | Four helpers have thirty minutes. Sequential draft slots require 10 minutes/two helpers, 15 minutes/five helpers, and 5 minutes/one helper. |
| `L5-W-X` | A draft assigns an announcement to Jo on Friday. The original notes cannot be opened, and you have no retained trusted copy. You need to decide whether this commitment is verified. |
| `L5-T-X` | A file form should accept PDFs up to 2 MB. A 3 MB PDF rejection case is proposed, but test execution stops before any response is observed. |

<details><summary>Compare your workflow</summary>

- **Everyday:** time is already correct: 10 + 15 + 5 = 30. The middle slot exceeds four helpers. Propose a middle-slot activity that uses at most four, then check whether that revised activity is feasible; do not claim feasibility from the count alone. If it cannot fit, reduce the scope or ask whether the available resources can change.
- **Work:** retain the draft as unverified, without announcing Jo's commitment. Recover the source or ask for confirmation of the owner and date. The lack of source evidence does not prove the commitment false; it prevents you from confirming it.
- **Technical:** expected rejection follows from the size limit, but there is no observed result. Record execution as interrupted/unconfirmed, retain the case and rerun when the test setup is usable. Do not call it passed or failed without an observed outcome.

</details>

## Make your own five-step card

Use your earlier artifact or a supplied case. Write one or two sentences for each step:

> Input and source version: …
>
> Draft I will produce: …
>
> Checks I will perform: …
>
> Keep / revise / set aside, for this use: …
>
> Recovery if a check, source or tool fails: …

**Self-check rubric:** someone else could identify the input; the draft has a useful shape; the checks could detect a concrete error; the decision states what use is justified; and recovery preserves the source while naming an action. Where only a count or format was checked, do not claim every aspect is validated.

Run the card once against an intentionally flawed sample. Record what you changed and what remains uncertain. You have designed a workflow, not connected an automation or sent a result.

**Take forward:** choose one step you would like help improving. In [Lesson 6: Give feedback someone can use](06-feedback-and-revision.md), you will ask a focused question, judge the response against the source and record a revision reason.

<!-- Author reference: draft LD-FND-005 0.1; refines FND-005. Original synthetic examples; time/staffing checks establish only the stated constraints, not operational feasibility. -->
