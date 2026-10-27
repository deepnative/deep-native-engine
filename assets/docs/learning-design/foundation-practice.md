# Put the six lessons together

Make one useful piece of work you can explain from source to revision. Choose an invented brief below. You can use your own fictional brief instead, but keep its facts and unknowns visible. Allow roughly twenty minutes; this is a practice estimate, not a deadline.

## Choose a fresh brief

| Route / case | Source | Useful output |
| --- | --- | --- |
| Everyday / `CAP-E` | A repair café has five helpers for ninety minutes on Saturday. Fifteen items are registered for inspection; repairs are not guaranteed. Room and start time are undecided. The organiser has allowed these notes to be used for an internal planning draft, not a final public invitation. | A simple session plan and the questions still needing a decision. |
| Work / `CAP-W` | A team will try a check-in process on Wednesday. Noor writes one page of instructions. Lee gathers four comments. Instruction and comment deadlines and the continuation-decision date are unset. These notes are for the internal planning team. | A task/owner/date table and an explicit list of open questions. |
| Technical / `CAP-T` | An upload form must accept PNG images up to 3 MB. Other file formats are unspecified. No tests have been run. Use fictional files and no customer logs or credentials. | Candidate test cases with expected behavior, source requirement and execution status. |

## Build your learning record

Use these six steps. Keep the source beside every version; a neat answer is not enough if you cannot explain where its claims came from.

1. **Choose:** name one draft task and one check that could reveal an error.
2. **Request:** write the needed facts, task, output shape, limits and check.
3. **Check:** inspect the flawed sample below, separate claims and repair it.
4. **Use/share:** identify the intended reader and what information the draft needs. Keep any different destination undecided unless the brief establishes it.
5. **Repeat:** write input → draft → check → decision → recovery for doing this task again.
6. **Improve:** write a practice feedback note, decide whether to revise, and record the reason beside your new or retained version.

**Teaching samples to inspect — deliberately flawed, not generated from your request:**

- **Everyday:** “Six helpers will repair all twenty registered items at 2 p.m. in the workshop.”
- **Work:** “Noor's instructions are due Tuesday. The trial is Friday. Lee owns the continuation decision.”
- **Technical:** “The PNG upload tests passed. JPEG files up to 3 MB are supported too.”

## A complete worked record: Everyday

**1. Task and check.** Draft a ninety-minute session plan. Check total duration, simultaneous helper demand and every factual claim against CAP-E.

**2. Request.** “Suggest a session plan for five helpers and ninety minutes on Saturday, with fifteen items registered for inspection. Use activity, duration and helpers-needed-at-that-time columns. Label proposed activities as suggestions. Keep room and start time undecided and do not promise that every item will be repaired. I will add the durations, check the peak helper requirement and compare claims with the brief.”

**3. Claim check and repair.** Six helpers conflicts with five; twenty registered items conflicts with fifteen. A 2 p.m. start and workshop location are not given. The promise to repair every item contradicts the brief's explicit “repairs are not guaranteed” limit. A corrected description is: “Five helpers have ninety minutes on Saturday for fifteen registered inspections. Repairs are not guaranteed; room and start time are to be confirmed.”

**Example proposed schedule:** setup 15 minutes with two helpers, inspection/repair attempts 60 minutes with five, tidy-up 15 minutes with three. That totals ninety minutes and never needs more than five helpers at once. It passes those two checks; it does not establish that all fifteen inspections or any repairs can be completed. The organiser still needs to assess task difficulty and practical feasibility.

**4. Use/share decision.** Keep a fictional planning copy for the internal planning discussion. No contact list is needed. The supplied scope does not establish a final public invitation or confirm the room and time.

**5. Repeatable workflow.** Retain the current brief → draft a schedule → check duration, staffing and factual claims → keep it for internal discussion if the stated checks pass, with unresolved feasibility and arrangements visible → if a check fails, revise the proposal; if the source is unavailable, retain an unverified draft and recover the source before confirming it.

**6. Practice feedback and revision.** “The first description says six helpers and twenty items, but CAP-E gives five and fifteen. Correct those numbers and remove the invented room/time and repair guarantee. I checked the supplied brief, not the real session.” The revised description above addresses those points. Revision reason: “I matched the known quantities and separated unknown arrangements and uncertain outcomes.” This is a practice comment, not evidence of a real review.

## Checks for the other routes

<details><summary>Work: what a faithful result must preserve</summary>

The known tasks are Noor's one-page instructions and Lee's four comments. The claimed Friday trial contradicts the supplied Wednesday date. Tuesday as the instruction deadline and Lee as the continuation-decision owner are not given. Wednesday is the process trial date, not every task's deadline. A useful table has the known task/owner rows with unknown dates, plus the Wednesday trial with owner not specified. The continuation decision remains open, with its owner and date unspecified.

A useful request asks for those columns and unknowns explicitly. A workflow checks each populated cell against the note, keeps the table for the stated internal audience and asks targeted questions about missing commitments. Feedback should point to one invented commitment and a source-based repair. “Noor's task is known but Tuesday is not” is more useful than “the table is wrong.”

</details>

<details><summary>Technical: what a faithful result must preserve</summary>

The PNG format and 3 MB limit establish a requirement, not a passing test. A fictional 4 MB PNG case can have expected rejection under the size rule, with status “not run.” JPEG behavior stays unspecified. Candidate cases can include a PNG at the limit and above it; no result is observed until a test is actually executed.

A useful request separates input, expectation, requirement and execution. The workflow checks the proposed cases against the brief, preserves “not run” and recovers from drafting failure using the retained source. Feedback should remove the invented passing result and JPEG rule, with a reason for each change. If someone later provides new requirements or observed results, keep their source/version separate from this original brief.

</details>

## Decide what you can show

| Evidence in your record | Shown / needs another try |
| --- | --- |
| A small task and a check capable of catching a mistake. | Point to the task and the actual comparison. |
| A usable request that retains facts and unknowns. | Identify the context, task, shape, limits and check. |
| Claim statuses supported by the source. | Explain one contradiction and one missing fact. |
| A deliberate input and audience choice. | Name the intended use and the source of its scope. |
| A repeatable workflow with recovery. | Show what you do when a source or draft fails. |
| A useful feedback decision and revision reason. | Keep the earlier version identifiable and explain your decision. |

Revisit the corresponding lesson for any “needs another try.” Finishing this record means you have an inspectable practice artifact. It is a starting point for another real or invented task, not a proficiency certificate.

Return to the [six-lesson reading map](README.md), or try the [interactive request/check/revision walkthrough](prototype/README.md). The interactive walkthrough currently covers that middle part of the sequence; it does not save this entire six-step practice to your member account.
