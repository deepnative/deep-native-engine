# Private assignment feedback

Issue [#545](https://github.com/deepnative/deep-native-engine/issues/545), linked to [#125](https://github.com/deepnative/deep-native-engine/issues/125). The 27 October 2026 owner direction authorizes private member text in the hosted learning journey. It does not promise a staffed response time, formal assessment, live AI processing or public sharing.

## Member journey

1. Choose an available assignment, save your private response and submit that saved version.
2. Choose **Prepare feedback for submission N**. Read the exact response and original rubric. A newer draft is never substituted.
3. Read the consent wording, check its separate box and create the private feedback copy. The wording version you agreed to is saved with the copy. No reviewer receives access automatically.
4. Open **Manage private copies and request feedback**, then explicitly request review. An administrator must separately grant one reviewer access to that exact copy for a finite interval.
5. Read published feedback and, while consent and reviewer authority remain active, send one clarification and receive one answer.
6. Withdraw consent to stop future reviewer reads and exchanges. Already published feedback remains visible to you. A withdrawn copy cannot be requested again; to ask for feedback once more, make a fresh copy of the same submission, which needs its own request and a new reviewer grant. Delete only the copy to retain your original assignment, or delete the original attempt to remove all linked copies and feedback.

Each copy retains its assignment, content version, submitted sequence, rubric version, submission time and response digest. It is labelled **Member assignment submission · private · unreviewed**. These labels do not establish authorship or formal competence.

## Consent, retention and appeal

Owner decision of 10 November 2026 ([#125](https://github.com/deepnative/deep-native-engine/issues/125)): a private feedback copy is kept until the member deletes the copy, deletes the original attempt or deletes their account. There is no appeal path; formal assessment and appeal stay with parked [#648](https://github.com/deepnative/deep-native-engine/issues/648).

The consent box carries one versioned wording, `assignment-feedback-v1` (`ASSIGNMENT_CONSENT_TEXT` in `src/assignment-evidence-values.ts`). It states:

- the purpose: private feedback from one reviewer an administrator assigns, and nothing else;
- how long the copy is kept, as above;
- what withdrawing does: it stops further reviewer access and keeps feedback already received;
- that feedback is not a formal assessment and has no appeal.

The version is sent with the form and saved on the copy (`assignment_evidence_origins.consent_version`, migration 137). A form with any other version is refused and nothing is copied; the page asks the member to open the step again. Repeating an original request still returns its own receipt, with the version that was agreed to. The receipt, the private copies list and Download my records (`assignmentEvidenceOrigins[].assignmentOrigin.consentVersion`, beside `acknowledgedAt`) show the version. Copies made before migration 137 have no version and say "before wording versions were recorded"; they are never back-filled, because nobody agreed to a version. `/terms` states the same retention and that there is no appeal.

Changing the wording means changing the text and the version together. Earlier copies keep their version. The download's format version is unchanged: one field was added inside an existing record.

## Uncertain results and rollback

If saving cannot be confirmed, the page retains the original request. **Inspect this copy request** opens its result in another tab. Repeating the original request deliberately recovers its receipt without making another copy or granting permission. A removed source stays removed when that request is repeated. Receipt exports omit replay keys and erased source details. If the application restarts, an old form can no longer be submitted. Keep the original request reference shown on the recovery page, open **Inspect an earlier copy request**, and enter the reference in that fresh form. It is sent only in the form body; the current account must own the result. This inspection remains available with new creation disabled.

`DNE_ASSIGNMENT_HANDOFF` defaults to `disabled`. Every Azure release sets it to `enabled` for the hosted demo (`scripts/azure-release.py` and `infra/app.tf`). Enabling it exposes new-copy controls. Turning it off blocks new handoffs while preserving owned receipt inspection, existing feedback, export and erasure. Existing arbitrary uploads and prepared examples retain their separate controls. The migration adds immutable source bindings and receipts; it does not rewrite existing member assignments or enable an external provider.

## Acceptance mapping

| Acceptance area                                                         | Scenario and executable evidence                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Exact owned submission and separate consent                             | AHO-01/02; assignment-evidence HTTP, store, route and view tests; L214–L216            |
| No automatic grant; exact authorized feedback                           | AHO-02/05; assignment-evidence integration tests and L214–L216                         |
| Coach workspace grants cannot read assignment copies                    | AHO-11; assignment-evidence integration and evidence unit tests                        |
| Canonical replay, uncertain commit and safe inspection                  | AHO-03; assignment-evidence unit/integration tests and L217–L218                       |
| Withdrawal, source deletion and copy-only deletion                      | AHO-06/07/08; assignment-evidence integration tests and L214–L216                      |
| Ownership, expiry and cross-member denial                               | AHO-04; assignment-evidence route, HTTP and native PostgreSQL lifetime tests           |
| Bounded export and damaged bindings                                     | AHO-09; assignment-evidence integration tests, member-export tests and L214–L217       |
| Configured creation with retained inspection during rollback            | AHO-10; runtime/configuration, route and native-restart integration tests; L217–L218   |
| Hosted release enables creation                                         | AHO-10; repository Azure release test                                                  |
| Later versions, goal changes and retirement never migrate a copy (#125) | AEV-01; assignment-evidence-versions integration test                                  |
| IT, non-IT professional and general-learning examples (#125)            | AEV-02; assignment-evidence-versions integration test                                  |
| Fresh copy after withdrawal; feedback stays not formal (#125)           | AEV-03; assignment-evidence-versions integration test                                  |
| Versioned consent wording with purpose, retention and no appeal (#125)  | CONSENT125-01/02; assignment-evidence unit tests, versions integration test, L214–L218 |
| Consent version on receipt, copy list and download; no back-fill (#125) | CONSENT125-03; views unit test and versions integration test                           |
| Copy, attempt and account deletion remove the consent record (#125)     | CONSENT125-04; versions integration test                                               |
| `/terms` states the retention and that there is no appeal (#125)        | TERMS-09; demo-terms unit test                                                         |

The register extends the existing 213 approved journeys to 218, retaining every prior journey and full-MVP requirement. Desktop and mobile cases use invented data in isolated test runtimes. Actual test results, exact revisions, CI, deployment and the separate milestone demonstration belong in the issue closeout; this guide alone establishes none of those results.
