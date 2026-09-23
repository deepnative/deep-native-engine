# Initial learning slice: scope and decision record

Owner: Tom Wu. Date: 21 September 2026. Claim: `initial-learning-20260921`. Parent: [roadmap #1](https://github.com/deepnative/deep-native-engine/issues/1). The owner explicitly requested initial development and confirmed “Build the first learning slice”: choose a goal, complete a beginner-friendly lesson/exercise, and save progress with unit/E2E gates. This supersedes the earlier application hold for this bounded local preview.

## Acceptance and evidence map

The executable register is [initial-learning-v7](../../tests/e2e/scenarios.json). Each scenario defines actor, preconditions, steps, expected result, issue links and criticality. Twenty-six scenarios run against the real server, PostgreSQL and disposable private object storage on desktop Chromium and mobile Chromium emulation; each must pass on both to count. The newest journeys exercise the private content draft/review/publish/retire workflow and version-pinned synthetic assessment across staff and member views. No external AI, payment, identity, storage, scanner or other provider is used.

| AC | Browser scenario | Observable result |
| --- | --- | --- |
| General learners have a complete beginner path | L01 | Choose everyday use, practise with an invented community event, complete and reload progress |
| Non-IT professionals have a suitable path | L02 | Choose work, practise with sample meeting notes, complete and reload |
| IT learners have a suitable path | L03 | Choose building, review a sample sign-up flow, complete and reload |
| Unfinished practice persists | L04 | Draft survives reload and return; completion stays zero |
| Invalid completion is honest | L05 | Input retained, errors shown, no saved/completed claim and no database write |
| Progress is private to its browser session | L06 | Separate sessions and injected learner IDs cannot read or overwrite each other's work |
| Cross-origin writes are rejected | L07 | Wrong/null Origin and invalid/missing CSRF cannot save or delete |
| Completion is versioned and idempotent | L08 | Duplicate completion and late drafts preserve the completed row and timestamp |
| Deletion is complete for the current preview | L09 | Confirmation deletes learner and exercise rows; old cookie cannot recover them |
| Expired/forged credentials grant no access | L10 | Expired session rotates and can restart; unknown token cannot access private work |
| The browser experience is usable and safe | L11 | Two welcome tabs, keyboard submission, escaped script text and narrow layout work |
| Storage failures remain recoverable | L12 | Real SQL failure shows unconfirmed outcome; prior saved data returns after recovery |
| Database disconnects do not crash the server | L13 | Terminate real idle PostgreSQL connections and recover the saved draft in the same server |
| Provider readiness is honest | L14 | All provider boundaries remain simulated without live-effect claims |
| Private workspace authorization is server-derived | L15 | Owner reads succeed; another member's direct API request is denied |
| Staff access is bounded and audited | L16 | Assignments expire/revoke, editors remain denied and exact-purpose support reads are audited |
| Cohort access grants only shared content | L17 | Exact membership/content succeeds without private or staff privilege |
| Evidence is consented, quarantined and private | L18 | Unsafe input and premature review fail; a clean owner download succeeds while another member is denied |
| Reviewer evidence access revokes immediately | L19 | Only private-review scope applies; assignment revocation blocks an already-issued link and editors remain denied |
| Circle evidence and derived data follow lifecycle rules | L20 | Exact active membership works; revocation blocks access and owner deletion removes source, derivative and metadata |

L04 is noncritical; the other nineteen are critical. Unit tests add configuration, validation boundaries, Host checks, missing Origin, startup and failure paths. Integration tests cover transaction constraints, session-expiry boundaries, independent connections, repeated migration, concurrent completion/draft writes, literal SQL-like text, private-object lifecycle and cascading deletion. Negative probes introduce an unimported executable file and a broken CSRF comparison in a temporary copy; both must fail verification.

Definition of done for this slice: all AC above evidenced; all required tests pass without retries/skips; >=99% each unit metric globally and per file; full shared gate passes on intended commit before pushing; independent review findings resolved; PR and resulting main CI pass; setup, privacy, operations and remaining scope documented; claims released with evidence. This does not close broader issue AC automatically.

## Architecture decision

Use a TypeScript modular monolith: Express server-rendered HTML/forms, PostgreSQL persistence, and plain CSS. Runtime/bootstrap, configuration, session/CSRF, validation, content, persistence and views are separate modules. Browser interactions work without application JavaScript. This is sufficient for the approved learning exercise and keeps one deployable application and one database. The historical plan suggested Next.js as a suitable default, not a requirement; React hydration, an ORM, queues and paid providers add no necessary behavior to this slice.

The accepted target architecture is detailed in [ADR-0002](decisions/ADR-0002-file-first-hosted-modular-monolith.md): keep the product dynamic and same-origin, move authored public curriculum into Git-versioned Markdown/YAML, and reserve PostgreSQL for private, mutable, transactional state. Hosting and deployment remain separately authorized.

Lesson ID and version are stored with the exercise. Completion is self-assessed practice, never qualified review or an AI assessment. The database is authoritative; completed records are immutable under duplicate and late submissions. Parameterized SQL and owner IDs derived from the session enforce isolation. Background and goal are content preferences, not staff roles, entitlements or purchases.

Use Node 24 LTS (exact version in `.nvmrc`), pinned package versions and `package-lock.json`. TypeScript 6 is used because the selected typescript-eslint release rejects TypeScript 7; the initial incompatible install failed and was corrected without forcing peer dependencies. Runtime packages Express, cookie-parser, Helmet and pg use MIT licenses. PostgreSQL uses the PostgreSQL license. Development packages use MIT or Apache-2.0 licenses; inspect lockfile/license changes when upgrading. No provider credentials are needed. Initial local development also exercised Node 26; CI and the reproducible setup use Node 24.

References checked: [Node releases](https://nodejs.org/en/about/previous-releases), [Express 5](https://expressjs.com/en/guide/migrating-5.html), [PostgreSQL parameters](https://node-postgres.com/features/queries), [pool lifecycle](https://node-postgres.com/apis/pool), [Vitest coverage](https://vitest.dev/guide/coverage.html), [focused-test prevention](https://vitest.dev/config/allowonly), [Playwright test isolation](https://playwright.dev/docs/best-practices).

## Privacy and failure boundaries

This is a loopback-only preview for invented data. It is not production authentication or a deployed member service. Both listener and database address are restricted to loopback; database URL query/fragment overrides are rejected. A random HttpOnly, SameSite=Strict cookie carries browser access, with only its SHA-256 hash stored. PostgreSQL derives the principal, owned workspace and any active typed grant on every private API read; request IDs never select the actor. Synthetic staff access follows the separate [CTP-005 authorization matrix](CTP-005-WORKSPACE-AUTHORIZATION.md). Anyone with a valid browser credential can act as that synthetic principal. There is no account recovery or cross-device login. Exact Host/Origin checks, per-session HMAC CSRF, escaped output, CSP and no-store responses address local browser threats. Referrer policy preserves same-origin form Origin headers while withholding cross-origin referrers.

Access expires after 30 days; expiry does not purge stored rows. Clearing cookies loses access, not stored data. Delete this preview removes the current learner, exercises, evidence metadata, review state, source objects and registered derivatives through the application cleanup hook. Operators may explicitly reset the disposable local database and ignored private-object directory together; direct database deletion is not evidence cleanup. Backups, automatic retention purge and production identity/recovery remain future work. Never enter real client, employer, health or other sensitive content. Cookie Secure/TLS, live staff authentication/bootstrap, production malware scanning, managed object storage, abuse controls and deployment hardening are required before a hosted service.

Database connection/statement timeouts bound failures. A failed request reports the outcome as unconfirmed because a commit acknowledgment may be lost. Reload to inspect saved state before retrying. Duplicate completion is safe; a later draft cannot overwrite completion. Restarting the server invalidates existing form CSRF tokens; refresh the page before submitting. Session access and persisted progress survive a restart. One application process runs the migration at startup; concurrent migration coordination and schema upgrade/rollback tooling are future requirements.

## Scope still open

The register preserves 27 full-MVP requirement families: nine original roadmap journeys, ten build-prompt journeys and eight ecosystem additions. [QA-002's proposed traceability map](QA-002-JOURNEY-TRACEABILITY.md) decomposes them into 100 reserved full-release browser IDs. Overlap remains explicit; none of those IDs is declared complete by this local slice. The complete member-to-qualified-reviewer workflow, participation/contributions, live identity verification/recovery, all browsers/accessibility acceptance, AI budgets/providers, paid entitlements, payments and commercial invariants remain outstanding.

Issue links: [#8](https://github.com/deepnative/deep-native-engine/issues/8), [#15](https://github.com/deepnative/deep-native-engine/issues/15), [#16](https://github.com/deepnative/deep-native-engine/issues/16), [#17](https://github.com/deepnative/deep-native-engine/issues/17), [#18](https://github.com/deepnative/deep-native-engine/issues/18), [#20](https://github.com/deepnative/deep-native-engine/issues/20), [#22](https://github.com/deepnative/deep-native-engine/issues/22), [#24](https://github.com/deepnative/deep-native-engine/issues/24), [#25](https://github.com/deepnative/deep-native-engine/issues/25), [#26](https://github.com/deepnative/deep-native-engine/issues/26), [#28](https://github.com/deepnative/deep-native-engine/issues/28), [#33](https://github.com/deepnative/deep-native-engine/issues/33). These are bounded contributions, not completion of their full definitions of done.

Before hosted testing, Tom must approve production identity/hosting and privacy operations. Before commercial access, Tom must decide foundation/participation access and pricing separately from optional coaching. Qualified-review operations, providers and participation moderation require their own readiness decisions. No live service, deployment, purchase, outreach or payment collection is authorized by this slice.
