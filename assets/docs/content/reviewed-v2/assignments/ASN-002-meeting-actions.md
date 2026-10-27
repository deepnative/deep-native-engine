---
id: ASN-002
version: 2
title: Turn synthetic meeting notes into accountable actions
owner: Deep Native Engine delivery team; Tom Wu is the recorded interim curriculum owner
sources: https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api; original repository teaching examples; PLAN-004-EDITORIAL-REVIEW-2026-10-27.md
rights: Original synthetic brief, reference answer and calibration samples; no external notes or personal data
goals: Make everyday work clearer; practise a noncoding planning workflow
backgrounds: Non-IT professional; general or exploratory learner; IT practitioner if chosen
prerequisites: FND-002 and FND-003 or equivalent; no coding, client or employment prerequisite
reviewed_on: 2026-10-27; Codex root editorial/source review; no human expert sign-off
next_review: 2027-01-27 or earlier when sources, examples or application behavior change
readiness: Editorially reviewed ordinary education; not imported or published by the application
limitations: Invented notes; not a record of a real meeting or an approved workplace process
accessibility: Text-first source notes and action table; no visual-only cue
reviewer: Codex root, claim DNE-2026-10-27-93-foundation-editorial-netcsc-root
rubric_version: 1
---

# Assignment: turn synthetic meeting notes into actions

**Time for learner:** about 25–30 minutes. **Feedback type today:** self-check only. A future formal review requires a qualified assigned reviewer and a funded review unit; this exercise provides no expert service.

## Brief and evidence boundary

These notes describe an imaginary team:

> The team agreed to trial a new intake checklist next Tuesday. Sam will draft the checklist before the trial. Alex will gather feedback after the trial. The team has not selected someone to announce the result, and no exact time or calendar date was written down.

**Deliverable:** a concise action table with task, owner, timing, source sentence and status; a short paragraph naming what the team still must decide; and one proposed message asking for clarification. Use “unknown” where the notes do not specify a value. Do not transform “next Tuesday” into a calendar date without the meeting date and timezone. You may write from an exploratory, office-work or technical-team perspective; the evidence rules are the same. No code or real meeting notes are needed.

## Synthetic reference response v1

| Action | Owner | Timing | Evidence in the notes | Status |
| --- | --- | --- | --- | --- |
| Draft the intake checklist | Sam | Before the trial next Tuesday; exact date unknown | “Sam will draft the checklist before the trial” | Planned, not confirmed complete |
| Trial the new checklist | Team; individual lead unknown | Next Tuesday; exact date and time unknown | “The team agreed to trial … next Tuesday” | Planned |
| Gather feedback | Alex | After the trial; exact date unknown | “Alex will gather feedback after the trial” | Planned |
| Announce the result | Unknown | Unknown | “The team has not selected someone to announce the result” | Decision needed |

Open decisions: identify the trial lead, the exact date/time and timezone, the announcement owner and when results should be shared. A suitable clarification message is: “Can we confirm who will lead Tuesday’s trial, the exact date/time, and who will announce the result? I’ve left those fields open in the action list.” This message is a draft; it has not been sent.

## Practice rubric v1 — maximum 8 points

Each criterion is scored 0, 1 or 2 against the submitted table and paragraph. Scores guide self-check and feedback discussion; they are not certification.

| Criterion | 0 | 1 | 2 | Evidence to cite |
| --- | --- | --- | --- | --- |
| Action fidelity | Omits or invents major actions | Captures most actions with a gap | Captures checklist, trial, feedback and announcement decision accurately | Action rows and source note |
| Owners and timing | Assigns unknown owner/date as fact | Some unknowns identified | Sam/Alex correct; trial lead, exact date/time and announcement owner explicitly unknown | Owner/timing columns |
| Traceability | No source connection | General citation only | Each action points to a source sentence and status | Evidence and status columns |
| Useful communication | Claims decisions already made or gives no next action | A question is present but incomplete | Clear clarification request names the unresolved decisions without sending it | Open decisions and draft message |

**Calibration sample A:** The reference response provisionally scores 8/8. A reviewer should cite each row and the open-decision paragraph; this is an illustrative note, not qualified sign-off.

**Calibration sample B:** “Sam drafts the checklist Tuesday morning. Alex leads the trial and announces the result Wednesday. Everything is assigned.” Provisional score: action fidelity 1 (recognizes some tasks), owners/timing 0 (invented lead, dates and announcement owner), traceability 0 (no cited note), communication 0 (false completion): **1/8**. Feedback should point to each invented claim and invite a corrected version rather than overwriting the original submission.

## Reviewer calibration and time boundary

At least two authorized reviewers should independently score the same synthetic samples, cite exact evidence, reconcile differences and record a dated interpretation before formal review. If a future optional pilot funds this review, the 30-minute unit must include preparation; no additional invisible expert session is promised. Peer comments and AI suggestions may identify missing fields but cannot publish this rubric's formal score. These practice criteria remain rubric v1 in asset version 2. A revised criterion creates a new rubric version and does not alter earlier results.

## Sources and editorial status

- [OpenAI, prompt engineering guidance, context and output format](https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api). Checked 27 October 2026.

These are factual background references, not reused lesson text or an endorsement. The invented examples and practice rules are authored for this repository. [The editorial record](../../../PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) identifies findings, version history and publication limits. This is ordinary educational material, not accredited instruction or qualified formal assessment.
