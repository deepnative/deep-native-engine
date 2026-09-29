# CTP-009 local assignment preparation boundary

The member learning path now lists matching current published local synthetic
assignments that cannot yet be chosen. An exact-version preparation page shows
the member's own prerequisite activity and a safe next step. The page is a
read-only explanation; it does not select an assignment, create an attempt,
start a lesson, complete an exercise or assess competence. The existing
PostgreSQL eligibility check remains the authority for selection and attempts.

The explanation reads one repeatable database snapshot for the active member.
It includes only current published curated local content that does not require
qualified sign-off. Missing, retired, superseded, malformed and audience-
inaccessible prerequisites do not expose hidden content or an action. A member's
prior exact-version activity remains intact when a source or direction changes.
Nested prerequisites show an actionable leaf when one is safely available.
Very large shared graphs may summarize repeated details; their displayed
satisfaction still uses the database's prerequisite decision, not a truncated
JavaScript approximation.

An action to a source lesson pins its version in the URL. A stale pinned link
fails instead of opening a newer lesson. Opening a current lesson records only
an opened state; the member must explicitly start and, where required,
self-assess it. The local foundation exercise has its separate existing
completion action. Returning to the checklist recomputes the member's state.
The page never exposes a blocked attempt control. Existing selection and start
guards still reject forged or stale requests.

This slice uses the current tables and adds no migration, provider, payment,
qualified curriculum approval or production entitlement. To roll it back,
revert its Git commit and rebuild. Existing private activity and assignment
history remain in their original tables and versions; no data rewrite is
required. Qualified publication and the full member-to-reviewer journey remain
open under their own issues and decisions.
