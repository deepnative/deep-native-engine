---
id: WF-002
version: 1
title: Review candidate test cases
owner: Tom Wu, interim content owner; acceptance pending
sources: ASN-001 synthetic QA assignment; original workflow drafted for this repository
rights: Original invented test set and comments; no third-party tests or production system
goals: Improve a technical workflow; check generated test suggestions
backgrounds: IT practitioner; non-IT professional or general learner choosing QA practice
prerequisites: FND-003 and basic reading of the ASN-001 brief; no code required
setup: Read the invented sign-up brief and candidate cases, then compare each claim with the brief before using the request template
supported_environment: Plain text manual exercise; no test runner, AI provider or client integration verified
estimated_cost: No service charge in this local preview; any future model cost is unknown
permissions: No account or external system access; use synthetic test cases only
license: Original synthetic demonstration; reuse terms pending owner decision
last_verification: 2026-09-23 source and metadata inspection only; no live test run
reviewed_on: Pending qualified QA and curriculum review
next_review: Before publication; proposed monthly and after requirement/tool change
readiness: Draft demonstration; no test was executed or provider compatibility verified
limitations: Hand-authored review of invented cases; requirements are deliberately incomplete
accessibility: Text-first case comparison and plain-language comments
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

“Compare each candidate case with the supplied brief. Mark supported, incomplete or unsupported. Suggest missing boundary cases. Do not claim any case passed and do not invent password policy. Identify how to test the no-account-disclosure requirement using synthetic accounts.”

## Hand-authored example review v1

| Draft case | Finding | Revision |
| --- | --- | --- |
| 1 | Incomplete: input and outcome are vague | Name a new synthetic account, valid known input and the observable confirmation; status **not run**. |
| 2 | Incomplete: “bad” and “error” are vague | Separate empty email and malformed email; expect useful validation without asserting unsupported exact wording. |
| 3 | Unsafe against the supplied privacy requirement | Compare new and existing synthetic addresses for user-visible account-existence disclosure; do not require the revealing text. |
| 4 | Unsupported requirement | Ask the product owner for password rules; do not mark eight characters as approved. |

Also add an empty-password case and a comparison of new/existing account responses. Record the environment, exact input and observed result only after a real approved test run. The expected behavior alone is not execution evidence.

## Human review and failure path

A qualified QA reviewer should compare the revised table with the current approved requirement version, then decide what may be executed. If the requirement is missing or changes, mark the affected case **blocked or needs revision**, not passed. If a generator claims it ran tests, require an actual run log from the real target; this draft used no tool or live app. This workflow's current compatibility is **unverified** and must be rechecked before publication or after requirement changes.
