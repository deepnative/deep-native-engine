---
id: FND-005
version: 2
title: Build a small repeatable workflow
owner: Deep Native Engine delivery team; Tom Wu is the recorded interim curriculum owner
sources: https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api; https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf; original repository teaching examples; PLAN-004-EDITORIAL-REVIEW-2026-10-27.md
rights: Original synthetic text; no external media, client information or third-party excerpts
goals: Everyday exploration; clearer work; technical workflow improvement
backgrounds: General learner; IT practitioner; non-IT professional
prerequisites: FND-002 and FND-003 or equivalent draft/check habit
reviewed_on: 2026-10-27; Codex root editorial/source review; no human expert sign-off
next_review: 2027-01-27 or earlier when sources, examples or application behavior change
readiness: Editorially reviewed ordinary education; not imported or published by the application
limitations: A workflow sketch; no automation or external side effect is connected
accessibility: Text-first ordered checklist; can be completed without software
reviewer: Codex root, claim DNE-2026-10-27-93-foundation-editorial-netcsc-root
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

Draw or write your loop using the labels **input → draft → check → decision → recovery**. For each arrow, name who may act. The three manual workflow examples in this content pack show longer examples of requirements drafting, test-case review and meeting-action extraction.

**Self-check:** Your loop contains a stop condition and makes no claim that an AI provider, email service or repository integration is connected. A failed draft can be retried from the source without sending an unreviewed result to someone else.

## Sources and editorial status

- [OpenAI, prompt engineering guidance, context and output format](https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api). Checked 27 October 2026.
- [NIST AI 600-1, Generative AI Profile (July 2024), sections 2.2, 2.4 and 2.8](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf). Checked 27 October 2026.

These are factual background references, not reused lesson text or an endorsement. The invented examples and practice rules are authored for this repository. [The editorial record](../../../PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) identifies findings, version history and publication limits. This is ordinary educational material, not accredited instruction or qualified formal assessment.
