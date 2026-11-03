# Administrator console

Only a current finite administrator session bound to verified shi@deepnative.io or tom@deepnative.io may open `/operator`. Enter deliberately through `/admin`; this does not replace the learning identity or renew expired authority. Ending administration or signing out revokes access. The console uses the landing palette and compact task layout.

Learners, Courses/services and Invoices share one workspace. The Learners card is a table of name, starting point, goal, joined date and account reference, sorted by name with unnamed accounts last, 25 per page with Previous/Next and a total. One search box matches part of a name, case-insensitive and literal, or an exact account reference. Selecting a learner keeps the page and search (ADMINTABLE-01..05, #641, journey L287). The console reveals enrollment titles, course-bundle state and invoice summaries, never private writing, files or email addresses. These are read-only summaries, not proof of a payment or active entitlement.

For the selected learner, **Compose courses for this learner** opens the existing invoice engine with that exact server-checked account selected. Review current published lesson/version, entered CAD amounts, one-time/monthly cadence, UTC start date and explicit tax before preparing the proposal. The learner still accepts the exact immutable terms separately; a proposal is not enrollment or a charge. Existing stale-source eligibility, authority, CSRF, original-operation inspection and replay protections apply. Planned services and unpublished content are not invented offers. Members manage reusable billing recipients separately in [Billing profiles](BILLING-PROFILES.md); the console does not expose or edit those private details.

With invoicing disabled, the console remains a read-only administration workspace with explicit unavailable billing actions. It never enables invoice mode, publishes content, renews staff authority, sends correspondence or charges money. No new database schema, provider or role is introduced.

## BDD mapping

| Scenario                                                         | Executable evidence                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ADMINCON01 coherent workspace and honest empty/disabled state    | Administrator entry route units, real PostgreSQL directory test, L277 desktop/mobile                                                    |
| ADMINCON02 exact learner selection and private-writing isolation | Administrator entry units/native, selected `adminOverview` units/native, L277 proposal ownership/no invoice                             |
| ADMINCON03 exact course/version/cadence/amount/date review       | Existing simple-invoice values/store/routes/native and L269 course proposal baseline; L277 reaches the same engine for an exact learner |
| ADMINCON04 direct denial/revocation/uncertainty/recovery         | Console units/native, L277 end/direct denial, retained L270–L272 and existing invoice operation-recovery tests                          |

Missing `/operator` failed expected200/actual404 before implementation. Existing billing and administrator behavior has passing baseline evidence; it was reused rather than reimplemented. L277 appends one critical scenario, moving v127→v128,273→274 scenarios and546→548 primary browser executions without changing any existing ID, full-MVP denominator or gate. Actual final source, original reports, review, merge/main readback, demo and release performance review belong to the live #570 delivery record; this document alone is not proof of completion.

## Required display names — #600

Registration and profile updates require a user-supplied display name (1–80 characters). Names are escaped, may repeat and are not verified identities or billing recipients. The bounded directory and coaching/course selectors show names; exact account references remain authoritative. The directory uses ordinary native links and expandable references. Existing unnamed accounts are labelled **Name needed** and receive an Account completion prompt without losing sessions or saved work. Names are included only in their owner's structured export and these existing administrator projections; sign-in email, private writing and files remain excluded from the directory. Migration087 adds a nullable legacy column without backfilling names and records marker87.

NAME01–05 maps to unit `display-name`, administrator route, store/domain/export tests; native `display-names`/`profile-boundary`; and critical L282 desktop/mobile. Existing L53 and F-BUILD-10-A retain native keyboard entry and all original actions. The prior register objects are preserved; version133 appends L282. Local focused results do not establish clean-source full verification, merge, deployment or qualified identity acceptance.

## Learner table — #641

ADMINTABLE-01..04 map to `administrator-entry-routes` units and real PostgreSQL `administrator-entry` tests, all of which failed before implementation. ADMINTABLE-05 and the browser journey are critical L287 on desktop and mobile. L277 and L282 now reach learners through the table. A malformed page falls back to page 1, and an out-of-range page clamps to the last one. A repeated parameter or a search over 120 characters is refused.
