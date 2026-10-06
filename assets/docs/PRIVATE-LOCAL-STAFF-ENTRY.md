# Local staff browser entry

Scoped private local delivery for [#475](https://github.com/deepnative/deep-native-engine/issues/475), under [CTP-019 #39](https://github.com/deepnative/deep-native-engine/issues/39). This adds browser entry to already provisioned staff work. It does not create a role, assignment, entitlement, qualified service or identity provider.

## Enable and use

Set `DNE_LOCAL_STAFF_ENTRY=enabled` in the local preview environment and restart the existing preview. The default is `disabled`; other values fail startup. Live mode cannot use these surfaces. Follow the [local setup](workflows/VERIFICATION.md) with invented data only.

1. Open `/staff/sign-in`. This requires no learner account. A short-lived independent form nonce is issued without creating a member.
2. Obtain a current finite trusted local credential through the existing protected setup process, such as [support administrator setup](PRIVATE-SAMPLE-SUPPORT.md). Keep credential files owner-only and outside public assets. Do not place their values in commands, URLs, issues, logs or screenshots.
3. Paste the credential in the password field and submit. The form never prefills a credential or accepts a role/redirect field. `/staff` shows tools for the current database role. Every destination separately checks its existing role, exact target/purpose grant and current lifetime.
4. Use the learner navigation independently: the `dne_preview` learner cookie is unchanged. Staff HTML under `/editor`, `/review`, `/operator` and `/moderate`, including supported uppercase/trailing-slash aliases, selects the separate `dne_staff` credential before its mutation CSRF check.
5. Return to `/staff` and choose **Sign out of staff tools**. If access has expired or been revoked, open `/staff/sign-in` for a fresh signout form. Signout requires its independent Origin/Host/CSRF protection but does not depend on current database admission.

The six current roles remain distinct. Editors and reviewers use the content workflow; reviewers may discover exactly granted sample feedback. Operators and platform administrators may use their existing support, synthetic registry, metrics and accounting surfaces. Only operators see the enabled local request-hold inspection link; its worklist and detail still require exact existing assignments. Moderators and platform administrators may open existing proposal and enabled circle-report tools, subject to destination grants. Only platform administrators see simulation controls and the synthetic observation register. A coach has an explicit empty state. The portal grants no work and allocates no minutes; unavailable tools are omitted.

## Authority, compatibility and recovery

The separately enabled [support assignment browser](PRIVATE-SUPPORT-ASSIGNMENT.md) adds **My local assignment ID** for operators and **Support request assignments** for administrators. It requires both local feature flags and an explicitly selected staff cookie; its administrator forms check and change exact grants. Opening the staff portal itself still grants no work.

The HttpOnly, SameSite=Strict staff cookie carries the existing bearer credential, not a new independently revocable server session. Current role and finite expiry are read from PostgreSQL; no role is cached in the cookie. Signout replaces its value with the noncredential `signed-out` marker. It never revokes the principal, protected CLI credential, other browsers, assignment grants, mixed API access or accounting. Existing expiry and administrator revocation still apply. Do not describe this as global logout or independent session revocation.

While the feature is enabled, explicit malformed, duplicate, signed-out, expired or revoked staff state cannot fall back to a different learner/legacy staff identity. Absence retains the existing legacy trusted-cookie behavior. The browser retains expired server credentials for denial/recovery rather than dropping the explicit state at the principal expiry instant. Cookie storage uses the existing preview retention rules; clearing cookies or disabling this feature restores absent/legacy semantics. A newly valid form submission replaces the signed-out state after fresh admission. Relevant duplicate or malformed cookies are rejected; remove only the affected new staff/entry cookie through local browser settings if ambiguity prevents opening a new form. Preserve the learner cookie.

Member-only progress, cohort, evidence ownership, export and mutation routes continue to use the learner/legacy cookie. The three existing mixed APIs—workspace-private read, evidence download-link and evidence download—also retain their original actor, purpose, capability, CSRF and audit semantics. A separate staff cookie cannot rescue a denied mixed request. `/review-minutes` is a member path.

All responses are no-store. Entry uses bounded scalar input, a signed five-minute nonce, exact configured Origin/Host and fixed redirects. Unexpected errors are sanitized and never replayed. Refresh a form after expiry or application restart. Admission locks the current principal then profile, uses the existing bounded `sampleFeedbackTransaction` acquisition/query/COMMIT/native release checks, and preserves a conservative monotonic expiry through synchronous HTTP handoff. A later revocation after a completed admission is enforced on fresh destination access; this is not a claim of immunity from changes after the read linearizes. Older destination readers retain their own existing lifetime contracts.

## Roll back

Set `DNE_LOCAL_STAFF_ENTRY=disabled` and restart. Entry, portal and signout return unavailable without admission. Staff HTML ignores the new cookie/marker and uses the pre-existing legacy identity behavior. There is no new database schema, session table, token renewal or migration to reverse. Existing principal/grant revocation remains the way to withdraw durable authority. This rollback does not itself revoke a trusted credential.

## Verification boundary

The accepted STAFF Given/When/Then mapping is recorded on [the issue design checkpoint](https://github.com/deepnative/deep-native-engine/issues/475#issuecomment-6006549519). Unit tests cover strict selection, role tools, nonce/input and bounded admission faults. Real PostgreSQL/HTTP tests cover admission ordering/expiry/native handback, separate identities, current grants, member/mixed API behavior and recoverable signout. Browser journeys add actual forms, cross-audience saved progress, granted support/effort and sample review, denial, signout and re-entry on both approved viewports. The [evidence mapping](PRIVATE-LOCAL-STAFF-ENTRY-EVIDENCE.md) names all twenty STAFF subscenarios and preserves development failures. See the delivery issue for exact revision, gate and demonstrated-main evidence; a test description alone is not a pass.

This slice leaves #39 and its qualified capacity, rate/correction and staffed-policy dependencies open. It establishes neither full-MVP acceptance, production authentication, live staffing, paid review nor deployment.
