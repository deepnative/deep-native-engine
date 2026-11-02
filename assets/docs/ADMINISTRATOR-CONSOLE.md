# Administrator console

Only a current finite administrator session bound to verified shi@deepnative.io or tom@deepnative.io may open `/operator`. Enter deliberately through `/admin`; this does not replace the learning identity or renew expired authority. Ending administration or signing out revokes access. The console uses the landing palette and compact task layout.

Learners, Courses/services and Invoices share one workspace. The directory shows at most100 account references with existing background/goal; an exact reference lookup can select an account outside that list. It reveals enrollment titles, course-bundle state and invoice summaries, never private writing, files or email addresses. These are read-only summaries, not proof of a payment or active entitlement.

For the selected learner, **Compose courses for this learner** opens the existing invoice engine with that exact server-checked account selected. Review current published lesson/version, entered CAD amounts, one-time/monthly cadence, UTC start date and explicit tax before preparing the proposal. The learner still accepts the exact immutable terms separately; a proposal is not enrollment or a charge. Existing stale-source eligibility, authority, CSRF, original-operation inspection and replay protections apply. Planned services and unpublished content are not invented offers. Reusable billing profiles remain #571.

With invoicing disabled, the console remains a read-only administration workspace with explicit unavailable billing actions. It never enables invoice mode, publishes content, renews staff authority, sends correspondence or charges money. No new database schema, provider or role is introduced.

## BDD mapping

| Scenario | Executable evidence |
| --- | --- |
| ADMINCON01 coherent workspace and honest empty/disabled state | Administrator entry route units, real PostgreSQL directory test, L277 desktop/mobile |
| ADMINCON02 exact learner selection and private-writing isolation | Administrator entry units/native, selected `adminOverview` units/native, L277 proposal ownership/no invoice |
| ADMINCON03 exact course/version/cadence/amount/date review | Existing simple-invoice values/store/routes/native and L269 course proposal baseline; L277 reaches the same engine for an exact learner |
| ADMINCON04 direct denial/revocation/uncertainty/recovery | Console units/native, L277 end/direct denial, retained L270–L272 and existing invoice operation-recovery tests |

Missing `/operator` failed expected200/actual404 before implementation. Existing billing and administrator behavior has passing baseline evidence; it was reused rather than reimplemented. L277 appends one critical scenario, moving v127→v128,273→274 scenarios and546→548 primary browser executions without changing any existing ID, full-MVP denominator or gate. Actual final source, original reports, review, merge/main readback, demo and release performance review belong to the live #570 delivery record; this document alone is not proof of completion.
