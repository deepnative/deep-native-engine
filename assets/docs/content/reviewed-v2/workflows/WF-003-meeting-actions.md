---
id: WF-003
version: 2
title: Extract actions from synthetic meeting notes
owner: Deep Native Engine delivery team; Tom Wu is the recorded interim curriculum owner
sources: https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api; original repository teaching examples; PLAN-004-EDITORIAL-REVIEW-2026-10-27.md
rights: Original invented notes and output; no real meeting or third-party document
goals: Make everyday work clearer; practise an accessible noncoding workflow
backgrounds: Non-IT professional; general learner; IT practitioner if chosen
prerequisites: FND-002 and FND-003 or equivalent; no coding required
setup: Read the invented notes, then check every proposed owner and timing against the notes before using the request template
supported_environment: Plain text manual exercise; no AI provider, calendar or messaging integration verified
estimated_cost: No provider or payment is used by this manual exercise; external tool costs are not specified
permissions: No account or external system access; use synthetic notes only
license: No new license granted; repository-authored educational examples, with third-party and member rights separate
last_verification: 2026-10-27 manual input/output comparison; no AI call or software test execution
reviewed_on: 2026-10-27; Codex root editorial/source review; no human expert sign-off
next_review: 2026-11-27 or earlier when source requirements or supported environment change
readiness: Editorially reviewed ordinary education; not imported or published by the application
limitations: Hand-authored output from invented notes; no real calendar date or owner approval
accessibility: Text-first notes and labelled table; no visual-only cue
reviewer: Codex root, claim DNE-2026-10-27-93-foundation-editorial-netcsc-root
---

# Workflow demonstration: extract meeting actions

**Purpose:** turn notes into a clear action list without inventing owners, dates or decisions. This is a hand-authored demonstration, not a live assistant or message-sending feature.

## Synthetic input

“The team will trial a new intake checklist next Tuesday. Sam drafts the checklist before the trial. Alex gathers feedback after the trial. Nobody was assigned to announce the result. The meeting date and exact trial time were not recorded.”

## Request template

“Create a concise table with action, owner, timing, supporting note and status. Use ‘unknown’ where the note does not say. Separate questions for the team. Do not convert ‘next Tuesday’ to a date or send any message. A human will verify every row against the note.”

## Hand-authored example output v1

| Action | Owner | Timing | Supporting note | Status |
| --- | --- | --- | --- | --- |
| Draft intake checklist | Sam | Before trial; exact date unknown | Sam drafts before trial | Planned |
| Trial the checklist | Team; lead unknown | Next Tuesday; exact date/time unknown | Team will trial | Planned |
| Gather feedback | Alex | After trial; exact date unknown | Alex gathers feedback | Planned |
| Announce result | Unknown | Unknown | Nobody assigned | Decision needed |

Questions: Who leads the trial? What is the exact date/time and timezone? Who will announce the result, and when? A draft clarification message could ask these questions, but it must remain unsent until a person approves it.

## Human review and failure path

Compare each owner and timing cell with the original note. If a generated output says Alex leads the trial or gives a calendar date, mark it unsupported and correct it before circulation. If the note is missing, stop and request the source rather than reconstructing it from memory. A saved action list is a draft, not evidence that any task was done. This workflow's compatibility with any live model or workplace system is **unverified**.

## Sources and editorial status

- [OpenAI, prompt engineering guidance, context and output format](https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api). Checked 27 October 2026.

These are factual background references, not reused lesson text or an endorsement. The invented examples and practice rules are authored for this repository. [The editorial record](../../../PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) identifies findings, version history and publication limits. This is ordinary educational material, not accredited instruction or qualified formal assessment.
