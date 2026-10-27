---
id: FND-002
version: 2
title: Ask for a useful result
owner: Deep Native Engine delivery team; Tom Wu is the recorded interim curriculum owner
sources: https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api; https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf; original repository teaching examples; PLAN-004-EDITORIAL-REVIEW-2026-10-27.md
rights: Original synthetic text; no external media, client information or third-party excerpts
goals: Everyday exploration; clearer work; technical workflow improvement
backgrounds: General learner; IT practitioner; non-IT professional
prerequisites: FND-001 or equivalent basic task choice
reviewed_on: 2026-10-27; Codex root editorial/source review; no human expert sign-off
next_review: 2027-01-27 or earlier when sources, examples or application behavior change
readiness: Editorially reviewed ordinary education; not imported or published by the application
limitations: Prompt structure improves clarity but cannot guarantee accuracy
accessibility: Text-first example with named sections and no color-dependent meaning
reviewer: Codex root, claim DNE-2026-10-27-93-foundation-editorial-netcsc-root
---

# Ask for a useful result

**Goal:** write a request with context, a clear task, an output format and a check. **Suggested time:** 12–15 minutes.

A useful request gives an assistant enough information to work within your limits. Four parts help:

1. **Context:** the situation and only the details you may share.
2. **Task:** the specific thing you want drafted or compared.
3. **Format and limits:** audience, length, time, available resources and what to leave out.
4. **Check:** how a person will verify important facts and mark uncertainty.

For example: “Using only these invented notes, draft a five-item action list for the team. Put each action in a table with owner, due date and source sentence. Write ‘unknown’ when the notes do not give a date. Do not invent decisions. I will compare each row with the notes before sharing.” This is more useful than “summarize the meeting” because it states both the output and a verification rule. It still needs human review.

## Practise one complete request

Choose one route and write all four parts. Use invented details only.

- **Exploratory:** Request a two-hour community-event plan for 12 volunteers, with a simple sequence and no invented venue or budget.
- **Non-IT professional:** Request an action table from these notes: “Sam drafts a checklist. Alex gathers feedback. The trial is next Tuesday. No owner was chosen for announcing results.”
- **IT practitioner:** Request test ideas for a sample email/password sign-up flow. Include success, invalid input and whether the screen reveals that an account exists; say which tests still need execution.

**Self-check:** List the supplied facts, name the requested output format, and write down one fact the assistant must not guess. For the meeting route, “announcing results” must have owner **unknown**. For sign-up, generated test ideas are not a passed test suite. For the event, a venue remains unknown. Revise the request if any of these could be presented as a fact.

**Next step:** Save the request and its verification plan as draft practice. Continue to [FND-003: Check before using an output](FND-003-check-outputs.md). Saving a practice draft does not claim it was executed or formally assessed.

## Sources and editorial status

- [OpenAI, prompt engineering guidance, context and output format](https://help.openai.com/en/articles/6654000-best-practices-for-prompt-engineering-with-the-openai-api). Checked 27 October 2026.
- [NIST AI 600-1, Generative AI Profile (July 2024), sections 2.2, 2.4 and 2.8](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf). Checked 27 October 2026.

These are factual background references, not reused lesson text or an endorsement. The invented examples and practice rules are authored for this repository. [The editorial record](../../../PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) identifies findings, version history and publication limits. This is ordinary educational material, not accredited instruction or qualified formal assessment.
