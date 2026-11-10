---
id: WF-002
version: 3
title: Review candidate test cases
owner: Deep Native Engine delivery team; Tom Wu is the recorded interim curriculum owner
sources: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-and-error-messages; original repository teaching examples; PLAN-004-EDITORIAL-REVIEW-2026-10-27.md; WORKFLOW-REREVIEW-2026-11-10.md
rights: Original invented test set and comments; no third-party tests or production system
goals: Improve a technical workflow; check generated test suggestions
backgrounds: IT practitioner; non-IT professional or general learner choosing QA practice
prerequisites: FND-003 and basic reading of the ASN-001 brief; no code required
setup: Read the invented sign-up brief and candidate cases, then compare each claim with the brief before using the request template
supported_environment: Plain text manual exercise; no test runner, AI provider or client integration verified
estimated_cost: No provider or payment is used by this manual exercise; external tool costs are not specified
permissions: No account or external system access; use synthetic test cases only
license: No new license granted; repository-authored educational examples, with third-party and member rights separate
last_verification: 2026-11-10 manual input/output comparison against current sources; no AI call or software test execution
reviewed_on: 2026-11-10; Claude Code editorial/source comparison, owner approval on #774; no human expert sign-off
next_review: 2026-12-10 or earlier when source requirements or supported environment change
readiness: Editorially reviewed ordinary education for manual use; served read-only at /workflows; not qualified assessment
limitations: Hand-authored review of invented cases; requirements are deliberately incomplete
accessibility: Text-first case comparison and plain-language comments
reviewer: Claude Code for netcsc, claim DNE-2026-11-10-774-v3-release-worker-z; owner approval recorded on #774
---

# Workflow demonstration: review candidate test cases

**Purpose:** inspect a draft test list for gaps and unsupported claims before treating it as useful work. This is a hand-authored demonstration, not a passing software test run.

## Synthetic input

The invented sign-up brief in ASN-001 requires email and password input, a success confirmation, useful invalid-input errors, and no disclosure that an email already has an account. Draft test list:

1. “Use a normal email. Expected: works.”
2. “Use a bad email. Expected: error.”
3. “Use an existing email. Expected: show ‘account already exists.’”
4. “Check password is at least eight characters.”

## Request template

“Compare each candidate case with the supplied brief. Mark it supported, incomplete or unsupported, and give every case the status **not run**. Suggest missing boundary cases. Where the brief gives no password rule, write ‘password rule needed from the product owner’. Identify how to test the no-account-disclosure requirement using synthetic accounts.”

## Hand-authored example review v1

| Draft case | Finding | Revision |
| --- | --- | --- |
| 1 | Incomplete: input and outcome are vague | Name a new synthetic account, valid known input and the observable confirmation; status **not run**. |
| 2 | Incomplete: “bad” and “error” are vague | Separate empty email and malformed email; expect useful validation without asserting unsupported exact wording. |
| 3 | Unsafe against the supplied privacy requirement | Compare the response to a new and an existing synthetic address: the visible message, and also whether the status or response time differs. Do not require the revealing text. |
| 4 | Unsupported requirement | Ask the product owner for password rules; do not mark eight characters as approved. Published guidance itself differs by context (for example, a longer minimum when no second sign-in factor is used), so the rule is the product owner’s decision. |

Also add an empty-password case and a comparison of new/existing account responses. Record the environment, exact input and observed result only after a real approved test run. The expected behavior alone is not execution evidence.

## Human review and failure path

The person responsible for the test run compares the revised table with the current approved requirement version, then decides what may be executed. If the requirement is missing or changes, mark the affected case **blocked or needs revision**, not passed. If a generator claims it ran tests, require an actual run log from the real target; this draft used no tool or live app. This manual comparison was checked against the supplied brief on 10 November 2026. Compatibility with an AI provider or test runner remains unverified; recheck the example when its requirements change.

## Sources and editorial status

- [OWASP Authentication Cheat Sheet, authentication responses and account creation](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-and-error-messages). Checked 10 November 2026.

These are factual background references, not reused lesson text or an endorsement. The invented examples and practice rules are authored for this repository. [The re-review record](../../../WORKFLOW-REREVIEW-2026-11-10.md) and the original [editorial record](../../../PLAN-004-EDITORIAL-REVIEW-2026-10-27.md) identify findings, version history and publication limits. This is ordinary educational material, not accredited instruction or qualified formal assessment.
