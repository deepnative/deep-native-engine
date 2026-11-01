# Verified owner administration

Only the verified member identities for **shi@deepnative.io** and **tom@deepnative.io** may enter administration. Addresses use the existing email verifier's lowercase/outer-whitespace normalization; aliases, lookalikes, a matching domain or an address typed into a form grant nothing. This is a synthetic-preview capability, not payment activation or commercial readiness.

## Owner journey

1. Sign into the existing learning account using its verified selected email. An unlinked account can use **Link an email** and confirm the ordinary one-use link. This never merges accounts or replaces an existing linked identity.
2. Open **My account → Administration**, then deliberately choose **Enter administration**. A separate HttpOnly staff cookie represents a server-checked session lasting at most eight hours and never beyond the member session. The learner cookie and saved work remain unchanged.
3. Use **Courses and invoices** to compose the already-supported course bundle proposals. Member acceptance, invoice state and access remain distinct; entering administration creates no proposal, enrollment, invoice or charge.
4. **End administration for this sign-in** revokes its bindings. Signing out of the member account also makes its old administrator credentials unusable, including copied old cookies. A new email sign-in requires deliberate new administrator entry; authority is never silently renewed.

If entry cannot be confirmed, no credential is returned and no operation is automatically replayed. Inspect the current administration page. End the uncertain session deliberately before entering again. Database/network failure is not proof of rollback. Real owner inbox verification and hosted acceptance must be observed separately from invented local tests.

## Enforcement and preservation

Migration083 adds `administrator_sessions` and the shared `authorized_staff_profiles` read view. It preserves physical staff profiles, principals, grants, audit records, member work and invoice history. Every application staff-profile authorization read uses the view. Non-administrator staff roles retain their existing scoped checks; an administrator needs a current verified selected member, current member token hash, non-deleting workspace and unrevoked finite binding. Materialized fences acquire member, workspace, identity and binding row locks in that order, matching signout and explicit ending. A reproduced native ending/read deadlock regression checks that revocation completes and the waiting read is denied. Existing actor expiry/deadline checks still apply.

Legacy/unattributed administrator tokens are intentionally denied, including direct backend reads, invoice writes and grant operations. Private CLI bootstrap alone no longer establishes usable administrator authority. Neither profile metadata nor a staff sign-in page can create the verified binding. Migration applies no grandfathered bindings and deletes no historical records. Inventory existing hosted authority before release; use only the normal Azure preservation/release workflow.

Local test/rehearsal setup explicitly models verified synthetic authority in newly generated loopback-only databases. Those identities and credentials do not exist in the hosted database, send no email and prove no real owner inbox possession. Historical-schema tests model the original pre-identity surface only in their isolated legacy schemas; the current migration replaces that surface and requires explicit verified authority thereafter. There is no runtime test bypass or configurable domain-wide administrator policy.

## Acceptance map

| Contract                                                        | Evidence                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ADMINONLY01 verified deliberate finite entry                    | `tests/unit/administrator-entry.test.ts`, native administrator-entry, browser L269                 |
| ADMINONLY02 exact identity and request denial                   | entry/route unit tests, native administrator-entry, browser L270                                   |
| ADMINONLY03 legacy/revoked/expired denial and serialization     | staff-entry unit, native administrator-entry, shared authorization regressions, browsers L270–L271 |
| ADMINONLY04 retained learner identity/work and signout          | native administrator-entry, browsers L269/L271                                                     |
| ADMINONLY05 unknown transaction outcome and deliberate recovery | entry/route unit tests, native administrator-entry, browser L272                                   |

These are executable scenario mappings, not a claim that a particular revision has passed or deployed. Consult issue565's original verification and release evidence. Console570 and billing profiles571 are separate dependent features. Payable invoices, invoice email, payments, new providers and qualified/full-MVP acceptance remain outside this slice.
