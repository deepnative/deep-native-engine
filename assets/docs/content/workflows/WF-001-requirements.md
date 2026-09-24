---
id: WF-001
version: 1
title: Requirements to acceptance checks
owner: Tom Wu, interim content owner; acceptance pending
sources: PLAN-001 scope map; original synthetic workflow drafted for this repository
rights: Original invented brief and output; no third-party template or client material
goals: Clarify requirements; practise an AI-assisted drafting workflow
backgrounds: IT practitioner; non-IT professional; exploratory learner
prerequisites: FND-002 and FND-003 or equivalent
setup: Read the invented brief, then use the request template with a human checking each proposed acceptance check
supported_environment: Plain text manual exercise; no AI provider or client integration verified
estimated_cost: No service charge in this local preview; any future model cost is unknown
permissions: No account or external system access; use synthetic text only
license: Original synthetic demonstration; reuse terms pending owner decision
last_verification: 2026-09-23 source and metadata inspection only; no live model run
reviewed_on: Pending qualified curriculum and workflow review
next_review: Before publication; proposed monthly and after a dependency or policy change
readiness: Draft demonstration; not run against a live AI provider or tested in a product
limitations: Hand-authored example; no claim of current tool compatibility or formal acceptance
accessibility: Text-first input, output and checks; no visual-only action
---

# Workflow demonstration: requirements to acceptance checks

**Purpose:** turn a short, ambiguous brief into testable candidate acceptance statements while keeping missing decisions visible. This is a maintained **draft demonstration**, not an automated feature.

## Synthetic input

“A neighbourhood group wants a sign-up sheet for a Saturday event. It needs volunteer names and preferred tasks. An organizer should see the list. The event lasts two hours. The venue has not been chosen.” No details about storage, visibility duration, accessibility format or volunteer contact permission were supplied.

## Request template

“Using only the synthetic brief, draft acceptance checks in plain language. For each check, name the actor, action and observable result. Separate unanswered questions from agreed requirements. Do not invent venue, contact collection, retention or publication rules. I will compare each check with the brief and ask the organizer to approve the gaps.”

## Hand-authored example output v1

| ID | Candidate acceptance check | Source or unresolved decision |
| --- | --- | --- |
| AC1 | Given a volunteer enters a name and preferred task, the organizer can view that entry in the sign-up list. | Supplied brief; who else may view it is unknown. |
| AC2 | The event plan shown to an organizer can represent a two-hour Saturday activity. | Supplied duration; exact start time is unknown. |
| Q1 | Who can view volunteer names, and how long may they be kept? | Requires a privacy/retention decision. |
| Q2 | Is a contact method needed, and if so what permission is required? | Not supplied; do not collect by default. |
| Q3 | What access format and assistance will be available for volunteers? | Requires an accessibility decision. |

## Human review and failure path

The organizer checks AC1–AC2 against the brief and answers Q1–Q3 before any implementation or publication. If a generated draft adds a venue, contact field or public listing, reject that addition and return to the original brief. If the source changes, create a new version with a change note; do not silently overwrite decisions already tested. This example did not run an AI call, build a sign-up sheet or collect volunteer data.
