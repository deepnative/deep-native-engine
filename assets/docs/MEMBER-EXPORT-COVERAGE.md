# What Download my records covers

Download my records (My account → Download my records, `src/member-export.ts`) gives a member their own records as JSON. This page lists every kind of record that belongs to a member's account but **isn't** in that download, with the reason.

"Belongs to the account" means the record is removed with the account, through the same `ON DELETE CASCADE` chains that [account deletion](MEMBER-DELETION-RETENTION.md) relies on. `tests/integration/member-export-coverage.test.ts` checks this page against the database catalog after all migrations:

- **EXPCOV-01/02:** every such table must be read by the download's queries or be listed below. A new table that is neither fails the test, naming it. A listed table that the download now reads, or that no longer goes with the account, fails it too.
- **EXPCOV-03:** held and withdrawn sample sessions are in the download (`sampleHolds`, v41), without the staff member, availability registry or hold operation.
- **EXPCOV-04:** simulated assessment results recorded on the member's work are in the download (`contentAssessments`, v41), without the reviewer. No page records these yet.
- **EXPCOV-05:** how many coaches are assigned to the member, and since when, is in the download (`coachAssignments`, v42) as one row, without any coach's email fingerprint or who assigned them.
- **EXPCOV-06:** test payments staff recorded by hand about the member are in the download (`manualPaymentObservations`, v42), labelled unverified, without the staff member.
- **SIGNEMAIL-05:** the member's verified sign-in email is in the download (`signInEmail`, v46, #796) as the readable address and when it was verified, without its fingerprint. Members verified before #796 have no row content until their next email-link or password sign-in.
- **RECACCESS-07:** each permission the member gave operators to download their records is in the download (`recordAccess`, v44), with how many downloads were made, and each download is in `staffAccess`, without the operator.
- **TERMS316-07:** every version of the coaching terms an administrator set for the member is in the download (`coachingTerms`, v45), without the administrator.
- **HOLDCANCEL-EXP-01:** when staff cancel one of the member's sample holds, the reason, the time and the original and replacement credit are in the download (`sampleHoldCancellations`, v47, #27), named by the same hold ID as `sampleHolds`. The reason is the stored code (`coach-unavailable`, `scheduling-error` or `member-request`); the member's receipt shows it in words. Never the staff member or the staff request.
- **EXPCOV-07/08:** each file the platform derived from a member's upload, such as extracted text, is listed in the download (`evidenceDerivatives`, v47): which upload, the kind, size, checksum and when. Never the storage key, and nothing once the upload is being removed. The derived bytes have no download of their own; no page creates derived files yet. Account deletion already removes the records and their stored bytes (`tests/integration/member-deletion.test.ts`).

The check is about which tables the download reads, not which columns. Each section's own tests decide which fields a member sees.

## Not covered here

- Uploaded files. Each one downloads from its own evidence page. Files derived from them are listed (`evidenceDerivatives`) but their bytes aren't downloadable. Program enrollments also have their own download on My courses.
- Records about the member that sit in another member's or a staff member's records.
- Hosted object storage, provider copies and backups. Database backups are kept up to 30 days (#12, owner decision 9 Nov 2026).

## Member records not in Download my records

"Open" marks a gap that a later change should close. The others are left out on purpose.

| Table                                      | Why it isn't in the download                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `administrator_sessions`                   | Sign-in: the hashed session token used while an administrator acts on the account. A secret, not member content                                                                      |
| `ai_spending_commitments`                  | Internal cost estimate per AI request attempt. The request is in `adapterJobs` and its use in `aiUsage`                                                                              |
| `assignment_grants`                        | Staff access grant to the workspace. The member sees each use in `staffAccess`, without the staff member or purpose                                                                  |
| `coaching_allowance_grants`                | Internal link from a coaching terms version to the units it granted (#27). The terms are in `coachingTerms`, the units and their write-offs in `testUnitGrants` and `testUnitEvents` |
| `cohort_memberships`                       | Open on #121: cohort membership belongs to the durable cohorts work                                                                                                                  |
| `learning_workspace_operations`            | Operation keys that make notebook saves safe to retry. The notebooks and writing are in `learningNotebooks` and `learningWriting`                                                    |
| `local_ai_hold_inspection_events`          | When an administrator gave or withdrew staff access to inspect a held AI request (#187). Staff-side grant history; reads aren't recorded                                             |
| `local_ai_hold_inspection_grants`          | Staff grant to inspect a held AI request. Staff-side, like the row above                                                                                                             |
| `local_ai_test_unit_jobs`                  | Link between an AI request and its test-unit reservation. Both are in the download (`adapterJobs`, `testUnitReservations`)                                                           |
| `local_program_enrollments`                | Has its own download on My courses (`program-enrollment.json`), with the lesson activity                                                                                             |
| `member_email_links`                       | Sign-in: hashed one-time email link tokens. A waiting link holds its address only until it is used or expires                                                                        |
| `member_login_emails`                      | Sign-in: the fingerprint of the sign-in address                                                                                                                                      |
| `member_password_reset_windows`            | Sign-in: hashed password reset tokens                                                                                                                                                |
| `member_passwords`                         | Sign-in: the password hash                                                                                                                                                           |
| `member_sessions`                          | Sign-in: the fingerprint of each signed-in browser's cookie and when it expires (#695). A secret, not member content                                                                 |
| `preview_circle_appeals`                   | Open on #196: appeals of moderation decisions belong to the circle moderation work                                                                                                   |
| `preview_circle_moderation_audit`          | Open on #196: moderation actions on the member's circle posts                                                                                                                        |
| `preview_circle_moderator_grants`          | Staff moderator grants for a circle. Not about a member                                                                                                                              |
| `private_sample_feedback_draft_operations` | A reviewer's draft operation keys. Published feedback is in `sampleFeedback`; another person's drafts are never exported                                                             |
| `review_time_grant_revocations`            | Administrator's record of revoking a staff review grant                                                                                                                              |
| `review_time_grants`                       | Staff access grant for review time. The allocation, entries and events are in `reviewTimeAllocations`, `reviewTimeEntries` and `reviewTimeEvents`                                    |
| `reviewer_evidence_grants`                 | Staff access grant to review a submission. The feedback is in `sampleFeedback`                                                                                                       |
| `simple_invoice_operations`                | Staff operation keys for invoice actions. The invoices are in `invoices`                                                                                                             |
| `staff_profiles`                           | The role of a staff account. Members have none                                                                                                                                       |
| `support_access_grants`                    | Staff access grant to the workspace for support. The member sees each use in `staffAccess`                                                                                           |
| `support_request_events`                   | Open on #195: staff actions on a support request. The member's requests and replies are in `supportRequests` and `supportReplies`                                                    |
| `support_request_grants`                   | Staff access grant to one support request                                                                                                                                            |
| `support_request_mutations`                | Operation keys for support request actions                                                                                                                                           |
| `support_request_notes`                    | Staff private notes on a support request (#195). Kept from members by design                                                                                                         |
| `support_time_events`                      | Staff time events. The member's allocations and entries are in `supportTimeAllocations` and `supportTimeEntries`                                                                     |
| `support_time_grant_revocations`           | Administrator's record of revoking a staff support time grant                                                                                                                        |
| `support_time_grants`                      | Staff access grant for support time                                                                                                                                                  |
| `upload_admission_leases`                  | Short-lived upload slots. Counters, not member content                                                                                                                               |
| `upload_admission_windows`                 | Hourly upload counts. Counters, not member content                                                                                                                                   |
