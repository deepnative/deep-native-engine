---
id: FND-003
version: 2
title: Check before using an output
owner: Deep Native Engine delivery team; Tom Wu is the recorded interim curriculum owner
sources: https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf; original repository teaching examples; PLAN-004-EDITORIAL-REVIEW-2026-10-27.md
rights: Original synthetic text; no external media, client information or third-party excerpts
goals: Everyday exploration; clearer work; technical workflow improvement
backgrounds: General learner; IT practitioner; non-IT professional
prerequisites: FND-001 and a draft from FND-002 or equivalent
reviewed_on: 2026-10-27; Codex root editorial/source review; no human expert sign-off
next_review: 2027-01-27 or earlier when sources, examples or application behavior change
readiness: Editorially reviewed ordinary education; not imported or published by the application
limitations: Self-checks do not replace qualified domain or legal review
accessibility: Text-first comparison table with explicit labels; no timed interaction
reviewer: Codex root, claim DNE-2026-10-27-93-foundation-editorial-netcsc-root
---

# Check before using an output

**Goal:** separate supported details from plausible but unsupported claims. **Suggested time:** 15 minutes.

Read an AI draft as if another person will depend on it. Compare every important statement with the material you supplied or another source you are allowed to use. Mark each as **supported**, **needs checking** or **unsupported**. A polished sentence is not evidence. If the source is incomplete, “unknown” is often the most accurate output.

Use this three-pass check:

1. **Facts:** names, numbers, dates and stated constraints match the source.
2. **Fit:** the response actually answers the task for the intended audience and format.
3. **Harm and uncertainty:** no private information, unearned credential, unsafe instruction or invented certainty is introduced.

## Practise with a deliberately flawed draft

Invented source note: “The community group has 12 volunteers and two hours on Saturday. The venue and budget are undecided.” Draft output: “The 15 volunteers will meet at the library at 9 a.m. and spend $200 on supplies.”

Create a three-column table: **statement**, **status**, **why/next check**. The number 15 is unsupported because the note says 12. The library, 9 a.m. and $200 are unsupported because no venue, start time or budget was supplied. The source also supports “Saturday” and “two hours”; both are missing from the flawed draft and should be retained in a corrected version. Rewrite the draft without guessing, or ask the group to decide the missing details.

Choose an additional route:

- **Non-IT professional:** Check a generated action list against the sample meeting notes from FND-002. A due date for announcing results must stay unknown.
- **IT practitioner:** Check generated sign-up tests against the supplied requirement. A suggested privacy test is not evidence that it was run or passed; add a field for execution status.

**Self-check:** Can another reader identify the source for each important claim and the next human decision? If not, retain the draft and mark it unverified. Formal review by a qualified person is a separate future service, not a result of this exercise.

## Sources and editorial status

- [NIST AI 600-1, Generative AI Profile (July 2024), sections 2.2, 2.4 and 2.8](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf). Checked 27 October 2026.

These are factual background references, not reused lesson text or an endorsement. The invented examples and practice rules are authored for this repository. [The editorial record](../../../PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) identifies findings, version history and publication limits. This is ordinary educational material, not accredited instruction or qualified formal assessment.
