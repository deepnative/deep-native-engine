# Private assignment feedback

Issue [#545](https://github.com/deepnative/deep-native-engine/issues/545), linked to [#125](https://github.com/deepnative/deep-native-engine/issues/125). The 27 October 2026 owner direction authorizes private member text in the hosted learning journey. It does not promise a staffed response time, formal assessment, live AI processing or public sharing.

## Member journey

1. Choose an available assignment, save your private response and submit that saved version.
2. Choose **Prepare feedback for submission N**. Read the exact response and original rubric. A newer draft is never substituted.
3. Check the separate consent box and create the private feedback copy. No reviewer receives access automatically.
4. Open **Manage private copies and request feedback**, then explicitly request review. An administrator must separately grant one reviewer access to that exact copy for a finite interval.
5. Read published feedback and, while consent and reviewer authority remain active, send one clarification and receive one answer.
6. Withdraw consent to stop future reviewer reads and exchanges. Already published feedback remains visible to you. Delete only the copy to retain your original assignment, or delete the original attempt to remove all linked copies and feedback.

Each copy retains its assignment, content version, submitted sequence, rubric version, submission time and response digest. It is labelled **Member assignment submission · private · unreviewed**. These labels do not establish authorship or formal competence.

## Uncertain results and rollback

If saving cannot be confirmed, the page retains the original request. **Inspect this copy request** opens its result in another tab. Repeating the original request deliberately recovers its receipt without making another copy or granting permission. A removed source stays removed when that request is repeated. Receipt exports omit replay keys and erased source details.

`DNE_ASSIGNMENT_HANDOFF` defaults to `disabled`. Enabling it exposes new-copy controls. Turning it off blocks new handoffs while preserving owned receipt inspection, existing feedback, export and erasure. Existing arbitrary uploads and prepared examples retain their separate controls. The migration adds immutable source bindings and receipts; it does not rewrite existing member assignments or enable an external provider.

## Acceptance mapping

| Acceptance area | Scenario and executable evidence |
| --- | --- |
| Exact owned submission and separate consent | AHO-01/02; assignment-evidence HTTP, store, route and view tests; L214–L216 |
| No automatic grant; exact authorized feedback | AHO-02/05; assignment-evidence integration tests and L214–L216 |
| Canonical replay, uncertain commit and safe inspection | AHO-03; assignment-evidence unit/integration tests and L217 |
| Withdrawal, source deletion and copy-only deletion | AHO-06/07/08; assignment-evidence integration tests and L214–L216 |
| Ownership, expiry and cross-member denial | AHO-04; assignment-evidence route, HTTP and native PostgreSQL lifetime tests |
| Bounded export and damaged bindings | AHO-09; assignment-evidence integration tests, member-export tests and L214–L217 |
| Configured creation with retained inspection during rollback | AHO-10; runtime/configuration, route and integration tests; L217 |

The register extends the existing 213 approved journeys to 217, retaining every prior journey and full-MVP requirement. Desktop and mobile cases use invented data in isolated test runtimes. Actual test results, exact revisions, CI, deployment and the separate milestone demonstration belong in the issue closeout; this guide alone establishes none of those results.
