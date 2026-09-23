---
id: FND-005
version: 1
title: Build a small repeatable workflow
owner: Tom Wu, interim content owner; acceptance pending
sources: PRODUCT-DIRECTION.md; PLAN-001 scope map; original teaching text drafted for this repository
rights: Original synthetic text; no external media, client information or third-party excerpts
goals: Everyday exploration; clearer work; technical workflow improvement
backgrounds: General learner; IT practitioner; non-IT professional
prerequisites: FND-002 and FND-003 or equivalent draft/check habit
reviewed_on: Pending qualified curriculum review
next_review: Before publication; proposed quarterly thereafter
readiness: Draft demonstration, not published or expert reviewed
limitations: A workflow sketch; no automation or external side effect is connected
accessibility: Text-first ordered checklist; can be completed without software
---

# Build a small repeatable workflow

**Goal:** describe a useful AI-assisted process with a human check and a recovery step. **Suggested time:** 15–20 minutes.

A workflow is more than one clever prompt. It names a repeatable input, a useful output, an owner of the final decision and a way to catch a bad result. Use this five-step loop:

1. **Choose an input** you are permitted to use. State its source and what may be missing.
2. **Draft a request** for one bounded output. Do not authorize messages, purchases, code changes or publication by implication.
3. **Check the output** against the input and a named acceptance rule.
4. **Decide** whether a person may use, revise or reject it.
5. **Recover** when data is missing, the result is wrong or the tool fails. Keep the original information and state what is unconfirmed.

## Practise with one route

- **Exploratory:** Turn invented community-event notes into a draft volunteer schedule. Accept it only if every role fits 12 people and two hours; ask the organizer for an undecided venue.
- **Non-IT professional:** Turn synthetic meeting notes into an action list. A human owner checks each action against the notes before sharing; unknown owners/dates remain unknown.
- **IT practitioner:** Turn synthetic sign-up requirements into candidate test cases. A tester reviews privacy and error cases, then records which tests were actually run. Generated cases are suggestions, not passing evidence.

Draw or write your loop using the labels **input → draft → check → decision → recovery**. For each arrow, name who may act. The three workflow demonstrations in this content pack show longer examples of requirements drafting, test-case review and meeting-action extraction.

**Self-check:** Your loop contains a stop condition and makes no claim that an AI provider, email service or repository integration is connected. A failed draft can be retried from the source without sending an unreviewed result to someone else.
