# Evidence upload limits

The evidence API accepts at most **1 MiB (1,048,576 bytes)** per request. The public nginx proxy now applies that same limit before forwarding evidence requests to the application. It covers the application's case-insensitive `/api/evidence` mount, trailing slash and nested paths. The existing application limit, ownership, consent, quarantine, Host/Origin and CSRF checks still apply. Other proxy paths retain their existing 16 MiB ceiling and their own application limits.

When the proxy refuses an oversized body it returns 413 with a fixed JSON explanation, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Choose a file of 1 MiB or less; the response does not invite an automatic retry of the same oversized file. Rejected bytes do not reach the upstream listener. Previously saved evidence is unchanged. An exact-limit request may reach the application, which still decides its authorization, file validity and consent; forwarding is not upload acceptance.

The proxy preserves both owned entry points' exact original Host/Origin pairing before canonical normalization, clears forwarded Host/Proto trust, preserves the ordinary browser cookie and keeps request logs disabled. The refusal contains no request body, query, cookie, member identity or filename. No member files are logged or retained by this control.

## Shared upload admission

Five evidence-creating routes are admitted against one shared budget before anything is saved:

- `POST /api/evidence`, before its body is read.
- The sample form (`POST /evidence`) and sample revision form (`POST /evidence/:id/revise`), after their small form body is checked, so a refused member keeps the title and text they typed.
- Prepared-sample copies (`POST /evidence/prepared`) and assignment-evidence copies (`POST /assignments/attempts/:id/handoff`), after the route is confirmed enabled and the copy instruction is well-formed (ownership and conflicts are checked later, so a well-formed copy that is then refused still uses budget) ([#587](https://github.com/deepnative/deep-native-engine/issues/587)). A refused copy shows the route's recovery page with the original instruction kept, so the member can inspect it or deliberately repeat it later.

A copy uses the same member, signed-out and whole-service windows and concurrency slots as an upload; it does not get a separate allowance. Read-only inspection (`POST /evidence/prepared/inspect`, `/assignment-feedback/inspect` and the handoff preview) is never admitted, so a member over budget can still check whether an earlier copy saved. Repeating the same copy instruction is admitted like any other request; after the window it replays the original receipt without creating a second copy. The team chose these bounds under the 27 October #315 disposition:

| Budget                                             | Limit                                      |
| -------------------------------------------------- | ------------------------------------------ |
| Each member                                        | 10 uploads per 10-minute window, 2 at once |
| All signed-out or invalid-session callers together | 20 per window                              |
| Whole service                                      | 200 per window, 6 at once                  |

Windows are fixed 10-minute periods on the database clock. An in-progress upload holds a lease until its upload work finishes, or until the connection closes if the work never started. A lease also stops counting after 60 seconds, so a stopped process cannot block a member for long. State lives in the existing PostgreSQL database, so a restart or a second application instance shares the same counts. Forwarding headers (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`) and workspace headers never change who is counted. Free account creation can spread uploads across new members; the whole-service budget is the ceiling for that case, and legitimate members may then be refused until the window ends.

A refusal returns 429 with `Retry-After`, `Cache-Control: no-store` and fixed guidance: wait the stated number of seconds, or wait for the other upload to finish. Saved evidence is unchanged and the refused request creates no metadata, object, scan job or consent change. If the limiter cannot answer within its 2-second lock wait (3-second statement and idle-transaction limits), or the database is unreachable, uploads fail closed with 503, `Retry-After: 60` and "Uploads are temporarily unavailable"; the application writes the fixed line `Upload admission unavailable; uploads are refused.` to its error log with no request data.

The operator diagnosis signal is `upload_admission_denials`: one count per hour and reason (`member_rate`, `member_concurrency`, `unauthenticated_rate`, `global_rate`, `global_concurrency`) and nothing else. Access is the existing database operator scope; there is no new page or export. The denial counts contain no IP address, member identity, cookie, filename or content. The member window rows and leases that enforce the per-member budget do reference the member for up to a day and are deleted with the member's account; no IP address, cookie, filename or content is stored anywhere in admission. Old rows are removed during later admissions, at most 100 of each kind per admission: denial counts older than 30 days, window rows older than 1 day and expired leases. Expired leases and past windows stop counting immediately; on an idle service, old rows stay until the next upload.

## Anonymous signup and password sign-in

Two routes do expensive or outward-facing work for anyone, so [#728](https://github.com/deepnative/deep-native-engine/issues/728) gives them their own counts, separate from the upload budget:

| Route                                                                                | Each visitor      | Whole service        |
| ------------------------------------------------------------------------------------ | ----------------- | -------------------- |
| `POST /start`, once the form is well formed and before the address is looked up      | 30 per hour       | 300 per hour         |
| `POST /password/sign-in`, before the address is looked up or the password is checked | 60 per 15 minutes | 1,200 per 15 minutes |

A visitor is the address our ingress vouches for: the rightmost `X-Forwarded-For` entry behind the proxy, with an IPv6 customer's whole /64 counted as one. Windows are fixed periods on the database clock. `anonymous_write_windows` holds only a keyed hash of the visitor, or the literal `service`, and rows are removed within a day. The per-address email and password-failure limits still apply.

A refusal returns 429 with `Retry-After`, `Cache-Control: no-store` and fixed guidance. Signup keeps what was typed except the password and creates nothing. Sign-in points to the email link. If the limiter can't answer, the route returns 503 with `Retry-After: 60` and does no work. The operator signal is one log line per refusal, `anonymous_write_refused` with the route, limit and address scope, and `anonymous_write_unavailable` for an outage. Neither carries an address.

What this doesn't do:

- Many addresses together are bounded by the service ceiling, not stopped. A distributed attack that reaches the ceiling also delays real signups and password sign-ins until the window ends; email sign-in links have their own count, below, so they stay available unless that one is reached too.
- 30 lookups per hour per address are still possible, so whether an email is registered can still be tested slowly.
- The hash key is random per process, so a restart renews visitor allowances. The service ceiling carries across restarts.
- A local process counts only public addresses, so local browser runs don't share one allowance. Hosted counts every visitor.
- Azure ingress or WAF limits aren't part of this and stay with the hosted review in #42.

Scenarios ANON-01..07 run against the real HTTP application and PostgreSQL in `tests/integration/anonymous-write-admission-http.test.ts`, with browser journey L300.

## Email links and password changes

Three more routes send real email to an address the caller names, or run the same costly hash. Before [#42](https://github.com/deepnative/deep-native-engine/issues/42) added these counts, the only limit on the emails was per member or address, so what one visitor could send grew with the free accounts they kept. Password changes had no limit.

| Route                                                                                        | Window     | Each visitor | Whole service |
| -------------------------------------------------------------------------------------------- | ---------- | ------------ | ------------- |
| `POST /email/attach`, once the address is well formed                                        | 1 hour     | 20           | 200           |
| `POST /email/sign-in`, once the address is well formed and before it is looked up            | 1 hour     | 60           | 1,000         |
| `POST /account/password`, once the password is acceptable and confirmed, before it is hashed | 15 minutes | 30           | 300           |

They use the same `anonymous_write_windows` table, keyed hash, ingress address, 429 and `Retry-After`, 503 when the limiter can't answer, and log lines as signup and sign-in, under the kinds `email_attach`, `email_sign_in` and `password_change`. The table's name predates these routes; two of them need a signed-in member, and they are still counted by address so free accounts can't multiply them. The existing limits of five emails an hour per member or address, and of 20 notices an hour to unused addresses, still apply.

A refused link request keeps the typed address and sends nothing. The refusal is decided before the address is looked up and reads the same either way, so it doesn't reveal whether an address is registered. A refused password change leaves the password as it was and never echoes it. A signup's own verification email is covered by the signup count, not these.

What this doesn't do:

- Many addresses together can still send up to the service ceilings. Reaching the sign-in link ceiling also delays real sign-in links until the window ends; password sign-in is counted separately and the refusal page offers it.
- A member who has lost their password and shares an address with an attacker may have to wait for a link.
- One inbox can still receive the existing five emails an hour.
- Invoice email is staff-only and isn't counted here.

Scenarios OUTWARD-01..08 run against the real HTTP application and PostgreSQL in `tests/integration/outward-email-admission-http.test.ts`, with browser journey L307. Before the change, a visitor's request past each allowance got 200 and its email or hash, against an expected 429.

## New private records

Four routes let a signed-in member create a new private text record. Before [#42](https://github.com/deepnative/deep-native-engine/issues/42) added this count, each request was size-limited but nothing limited how many, so one visitor could fill the shared database with as many rows as they liked across the free accounts they kept.

| Route                                                                                                                  | Window | Each visitor | Whole service  |
| ---------------------------------------------------------------------------------------------------------------------- | ------ | ------------ | -------------- |
| `POST /milestones`, `POST /career/entries`, `POST /career/drafts` and `POST /contribute`, once the form is well formed | 1 hour | 120 together | 2,000 together |

They share one count under the kind `member_record`, with the same table, keyed hash, ingress address, 429 and `Retry-After`, 503 when the limiter can't answer, and log lines as the routes above. A refused or unanswered request saves nothing and shows the form again with what was typed. Edits, deletes, reads and invalid forms aren't counted.

What this doesn't do:

- A member's total still grows by up to the allowance every hour, and the milestone and career lists still read every row without a page limit.
- A class or office behind one address shares the 120.
- Other member writes, such as notebooks, reflections and support requests, aren't counted here. Support intake isn't enabled on the hosted site, and circle posts have their own cap.

Scenarios RECORD-01..06 run against the real HTTP application and PostgreSQL in `tests/integration/member-record-admission-http.test.ts`, with browser journey L310. Before the change, every creation past the allowance was saved, with 303 where 429 was expected. Every migration re-runs at each start, so migration 109 now re-adds its narrower kind check only before 111 exists. Without that, RECORD-06 showed the service would refuse to start once a `member_record` row existed.

## Scope and remaining work

[#315](https://github.com/deepnative/deep-native-engine/issues/315) covers the early 1 MiB body boundary and shared rate/concurrency admission for evidence uploads, and [#587](https://github.com/deepnative/deep-native-engine/issues/587) extends that admission to the two evidence copy routes. Every other API surface is outside this control and remains under [#42](https://github.com/deepnative/deep-native-engine/issues/42). This change adds no new service, provider, WAF or DDoS protection claim, and a fixed-window limit allows up to twice a budget across a window boundary. Source and local fixture evidence do not prove a live deployment or full hosted abuse protection.

The existing Azure production parking and deployment controls are unchanged. Follow the [deployment guide](workflows/AZURE-DEMO-DEPLOYMENT.md) and current owner instructions before any authorized release. Do not enable a parked workflow or deploy this change as part of local validation.

## Behavioral evidence

Admission scenarios ADMIT-01..09 run against the real HTTP application and PostgreSQL in `tests/integration/upload-admission-http.test.ts`, including a held-open concurrent upload, a second and restarted instance on the same database, spoofed headers, a held advisory lock and an unreachable database. Browser journey L278 shows a refused member keeping their typed sample and saving it after the window. Before the change, ADMIT-02 observed 201 for a member's eleventh upload against expected 429.

Copy scenarios ADMIT-10..13 run in `tests/integration/upload-copy-admission-http.test.ts`: both copy routes refused once the budget is used, copies counted in the same windows with no lease left behind, inspection while over budget and replay of the original copy after the window on both routes, and both routes failing closed under a held advisory lock. Browser journey L279 shows a refused provided copy kept and repeated after the window. Before the change, a member over budget still got a prepared-sample copy (200 against expected 429), and admitted copies left no window rows. PREPARED-04's four concurrent identical HTTP copies may now include a refusal from the member's two concurrent slots; each refused one is repeated and must replay the same single source, and the test also races four identical originals directly against the store to keep its concurrency proof.

The owned native nginx fixture has an upstream observer that accepts 16 MiB and logs only method plus normalized path, so its own default 1 MiB limit cannot masquerade as a refusal at the public proxy. Before the proxy change, BCAP-01 observed 200 and one upstream request for 1 MiB + 1, against expected 413 and zero upstream requests. An earlier status-only probe had passed because the observer inherited nginx's default limit; that result is preserved as a fixture-masking baseline, not the meaningful red.

BCAP-01..05 cover canonical and legacy entry points; exact-limit acceptance; declared and chunked oversized bodies; case, trailing-slash, encoded and nested evidence paths; no upstream access for refused bodies; fixed private refusal; ordinary recovery with the same cookie; foreign/crossed/missing write origins; and unchanged larger allowance on unrelated paths. Existing Host/Origin, maintenance/restoration and private-log cases remain required. The observer is an invented fixture, not a substitute for actual application authorization or private-object tests in the full gate.

A delivery is complete only after exact clean verification, the ordinary full pre-push hook, original PR and resulting-main CI, guarded merge, actual dedicated verified-main proxy demonstration, truthful partial issue reconciliation and safe owned cleanup. Source changes and passing components alone do not establish delivery, deployment, qualified review or full-MVP acceptance.
