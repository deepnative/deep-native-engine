---
id: WF-003
version: 1
title: Extract actions from synthetic meeting notes
owner: Tom Wu, interim content owner; acceptance pending
sources: ASN-002 synthetic meeting assignment; existing local exercise; original workflow drafted for this repository
rights: Original invented notes and output; no real meeting or third-party document
goals: Make everyday work clearer; practise an accessible noncoding workflow
backgrounds: Non-IT professional; general learner; IT practitioner if chosen
prerequisites: FND-002 and FND-003 or equivalent; no coding required
reviewed_on: Pending qualified curriculum and workflow review
next_review: Before publication; proposed monthly and after source/process change
readiness: Draft demonstration; no message sent or AI provider tested
limitations: Hand-authored output from invented notes; no real calendar date or owner approval
accessibility: Text-first notes and labelled table; no visual-only cue
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
