---
id: ASN-001
version: 1
title: Review a synthetic sign-up flow
owner: Tom Wu, interim content owner; acceptance pending
sources: Existing synthetic sign-up exercise in src/content.ts; PRODUCT-DIRECTION.md; original assignment drafted for this repository
rights: Original synthetic brief, reference answer and calibration samples; no external code or private data
goals: Improve a technical workflow; practise evidence-based testing
backgrounds: IT practitioner; accessible to exploratory learners who choose a technical example
prerequisites: FND-002 and FND-003 or equivalent prompt/check habit; no coding required
reviewed_on: Pending qualified QA and curriculum review
next_review: Before publication; proposed quarterly or after requirement change
readiness: Draft demonstration; rubric and calibration unapproved
limitations: Invented feature with incomplete requirements; no real app or tests were executed
accessibility: Text-first test table; no visual-only cue; any code is optional
---

# Assignment: review a synthetic sign-up flow

**Time for learner:** about 30 minutes. **Feedback type today:** self-check only. A future formal review would require an assigned qualified reviewer and a funded, version-pinned 30-minute review unit; this draft creates neither.

## Brief and evidence boundary

An invented web app asks for an email address and password. Successful sign-up displays a confirmation that the request was accepted. Invalid input receives a useful error. The sign-up response must not disclose whether the email already belongs to an account. No password length, email delivery, rate limit, persistence, identity verification or account-recovery rule has been supplied. Those are **questions**, not facts to assume. Use only this brief. Do not connect to a real service or use real addresses.

**Deliverable:** a table of at least five candidate test cases with input condition, expected observable result, why it matters and execution status. Add two clarifying questions and one paragraph on how you would validate the privacy requirement. Mark all cases **not run**; a generated list is not test evidence.

## Synthetic reference response v1

| Case | Input/condition | Expected observable result | Why | Status |
| --- | --- | --- | --- | --- |
| Q1 | New synthetic email plus otherwise valid password | Request accepted; confirmation shown | Core success path | Not run |
| Q2 | Empty email | Useful validation error; request not accepted | Missing required input | Not run |
| Q3 | Malformed email such as `not-an-address` | Useful validation error; request not accepted | Invalid format | Not run |
| Q4 | Empty password | Useful validation error; request not accepted | Missing required input | Not run |
| Q5 | Email that already exists in a synthetic test dataset | Response must not reveal existence through user-visible wording | Account-enumeration privacy | Not run |
| Q6 | A new and existing synthetic email under equivalent conditions | Compare wording and observable differences without making an unsupported timing guarantee | Check privacy claim more broadly | Not run |

Clarifying questions: What makes a password valid? Does “confirmation” mean only an on-screen message, or should a separate email be sent? The reference cannot decide these. A tester would run the cases in an approved isolated environment, capture actual responses and compare new-versus-existing behavior; timing and abuse limits require additional approved requirements and test design. The reference does not claim Q1–Q6 pass.

## Draft rubric v1 — maximum 8 points

Each criterion is scored 0, 1 or 2 against the submitted table and questions. A score is a calibration aid, **not** a verified competence label.

| Criterion | 0 | 1 | 2 | Evidence to cite |
| --- | --- | --- | --- | --- |
| Source fidelity | Invents required behavior or treats unknowns as facts | Mostly follows brief but misses an unknown | Uses supplied behavior and explicitly lists missing requirements | Brief sentence and question row |
| Useful coverage | Misses success or invalid input | Covers success and some invalid input | Covers success, empty/malformed input and clear expected outcomes | Case IDs and expected results |
| Privacy reasoning | Omits existing-account exposure | Names the risk without a comparable check | Compares new/existing account responses without claiming a guarantee not in the brief | Privacy case IDs and validation plan |
| Evidence honesty and clarity | Claims tests passed without running or lacks a readable table | Marks status but leaves steps/outcomes unclear | All cases clearly say not run, with readable inputs, outcomes and why | Status and table columns |

**Calibration sample A:** The reference response above would provisionally score 8/8 if a qualified reviewer agreed that its comparisons are appropriate. Cite Q1–Q6 and both questions. This is an illustrative scorer note, not reviewer sign-off.

**Calibration sample B:** “Try a normal email, bad email and short password. The app passes. Existing users should see ‘account already exists.’” Provisional score: source fidelity 0 (invented password rule), coverage 1 (some cases but unclear results), privacy 0 (reveals existence), evidence honesty 0 (claims a pass without execution): **1/8**. A reviewer should explain those gaps and invite a revised v2 submission rather than silently replacing v1.

## Reviewer calibration and time boundary

Two qualified reviewers should score both samples independently, cite the exact table row or sentence for each criterion, then resolve disagreement and sign a dated rubric interpretation before formal use. A later rubric edit creates v2 and must not change a completed v1 assessment. If this assignment is part of the historical optional pilot, one 30-minute review unit includes preparation (about 20 review + 10 prep); the organization must verify an actual assigned reviewer and available capacity before accepting that service. The current pack reserves no time and offers no paid review.
