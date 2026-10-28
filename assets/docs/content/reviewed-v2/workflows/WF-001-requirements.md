---
id: WF-001
version: 2
title: Requirements to acceptance checks
owner: Deep Native Engine delivery team; Tom Wu is the recorded interim curriculum owner
sources: https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api; original repository teaching examples; PLAN-004-EDITORIAL-REVIEW-2026-10-27.md
rights: Original invented brief and output; no third-party template or client material
goals: Clarify requirements; practise an AI-assisted drafting workflow
backgrounds: IT practitioner; non-IT professional; exploratory learner
prerequisites: FND-002 and FND-003 or equivalent
setup: Read the invented brief, then use the request template with a human checking each proposed acceptance check
supported_environment: Plain text manual exercise; no AI provider or client integration verified
estimated_cost: No provider or payment is used by this manual exercise; external tool costs are not specified
permissions: No account or external system access; use synthetic text only
license: No new license granted; repository-authored educational examples, with third-party and member rights separate
last_verification: 2026-10-27 manual input/output comparison; no AI call or software test execution
reviewed_on: 2026-10-27; Codex root editorial/source review; no human expert sign-off
next_review: 2026-11-27 or earlier when source requirements or supported environment change
readiness: Editorially reviewed ordinary education; not imported or published by the application
limitations: Hand-authored example; no claim of current tool compatibility or formal acceptance
accessibility: Text-first input, output and checks; no visual-only action
reviewer: Codex root, claim DNE-2026-10-27-93-foundation-editorial-netcsc-root
---

# Workflow demonstration: requirements to acceptance checks

**Purpose:** turn a short, ambiguous brief into testable candidate acceptance statements while keeping missing decisions visible. This is a manually checked educational example, not an automated feature.

## Synthetic input

“A neighbourhood group wants a sign-up sheet for a Saturday event. It needs volunteer names and preferred tasks. An organizer should see the list. The event lasts two hours. The venue has not been chosen.” No details about storage, visibility duration, accessibility format or volunteer contact permission were supplied.

## Request template

“Using only the synthetic brief, draft acceptance checks in plain language. For each check, name the actor, action and observable result. Separate unanswered questions from agreed requirements. Do not invent venue, contact collection, retention or publication rules. I will compare each check with the brief and ask the organizer to approve the gaps.”

## Hand-authored example output v1

| ID | Candidate acceptance check | Source or unresolved decision |
| --- | --- | --- |
| AC1 | When a volunteer submits an entry, the sign-up sheet records the supplied name and preferred task. | Supplied input fields; validation and storage rules still need decisions. |
| AC2 | Given submitted entries, when the organizer views the sign-up list, then each entry shows its supplied name and preferred task. | Organizer visibility is supplied; who else may view the list is unknown. |
| Q1 | Who can view volunteer names, and how long may they be kept? | Requires a privacy/retention decision. |
| Q2 | Is a contact method needed, and if so what permission is required? | Not supplied; do not collect by default. |
| Q3 | What access format and assistance will be available for volunteers? | Requires an accessibility decision. |

The two-hour Saturday event and undecided venue are context. They do not establish a requirement for an event-planning screen or authorize collection of contact details.

## Human review and failure path

The organizer checks AC1–AC2 against the brief and answers Q1–Q3 before any implementation or publication. If a generated draft adds a venue, contact field or public listing, reject that addition and return to the original brief. If the source changes, create a new version with a change note; do not silently overwrite decisions already tested. This example did not run an AI call, build a sign-up sheet or collect volunteer data.

## Sources and editorial status

- [OpenAI, prompt engineering guidance, context and output format](https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api). Checked 27 October 2026.

These are factual background references, not reused lesson text or an endorsement. The invented examples and practice rules are authored for this repository. [The editorial record](../../../PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) identifies findings, version history and publication limits. This is ordinary educational material, not accredited instruction or qualified formal assessment.
