# Student coaching terms

**Issue:** [#316](https://github.com/deepnative/deep-native-engine/issues/316), under Tom's [#35](https://github.com/deepnative/deep-native-engine/issues/35). Owner decisions of 9 November 2026.

There is no fixed coaching offer. A platform administrator sets each student's terms on the student's page under **Administration → Monthly coaching** (`/operator/coaching/<student>`):

- price (CAD), which is the student's own coaching price and covers their allowances;
- start and end date of the coaching period, and the renewal date;
- allowances: expert review minutes, coaching sessions and AI requests.

Each save is a new version (migration 126, `coaching_terms`). Earlier versions can't be changed or deleted. A form opened before someone else saved is refused as out of date (409), and the same operation replayed returns the same version. Saves need a platform administrator, the page's CSRF token and the site's own origin.

The student sees their current terms, read-only, on **Monthly coaching hours** (`/account/coaching`), with: "There are no cancellation or refund rules. To ask about changes, contact info@deepnative.io." Every version is in Download my records (`coachingTerms`, export v45), without the administrator. Deleting the account removes them.

## Allowance units (#27)

Saving terms also turns two allowances into units in the entitlement ledger for the coaching period, from 00:00 Toronto time on the start date to 00:00 on the day after the end date (migration 131, `coaching_allowance_grants`):

- expert review minutes become `review_minutes` units, which review-time allocations draw down;
- AI requests become `study_requests` units, which metered AI requests draw down (in grants of at most 100,000).

A later version keeps the units in line with the new numbers:

- **Same period:** a higher number grants only the difference. A lower number writes off unused units with the ledger's adjust event; units already held or used are never taken back.
- **Overlapping, different dates** (a correction): the earlier period's unused units are written off, and what was already held or used counts towards the new number.
- **A later, separate period** (a renewal): granted on its own; the current period's units keep running to its end.

Nothing is granted for a period that has ended or for a student whose account isn't active (signed out more than 30 days); saving again later grants what's missing. A replayed save grants nothing twice. The student's Monthly coaching hours page and the administrator's page show, for the current terms, what's left, held and used. The units also appear under the student's test units and in Download my records (`testUnitGrants`, `testUnitEvents`).

Limits: coaching sessions stay an agreed number, because no ledger category counts sessions. If a reservation on a written-off grant is later released, those units return to that grant as the ledger does today.

## What this doesn't do

- The renewal date is shown, not acted on. Renewal and acceptance stay with #317; there is no cancellation flow (#319).
- Invoices are unchanged; monthly coaching hours and invoices work as before ([MONTHLY-COACHING-INVOICES.md](MONTHLY-COACHING-INVOICES.md)).

Tests: TERMS316-01..07 in `tests/integration/coaching-terms.test.ts`; export index in `tests/unit/member-export.test.ts`. Allowance units: ALLOW27-01..08 in `tests/integration/coaching-allowances.test.ts` and `tests/unit/coaching-allowances.test.ts`; browser journey L330 in `tests/e2e/coaching-invoices.spec.ts`.
