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

## Invoicing the terms (#318)

On the same page, **Invoice these coaching terms** issues one invoice for the current terms version ([#318](https://github.com/deepnative/deep-native-engine/issues/318), migration 132):

- one line, "Coaching · <start> to <end> · terms version N", at the terms price;
- configured invoices are from Deep Native Inc. with 13% HST computed by the server and the e-Transfer/cheque wording (`src/invoice-issuer.ts`, #797); sample mode asks for an invented tax instead;
- billed to the student's saved billing recipient (name, email, optional company). Until the student saves one on **Billing recipient**, nothing can be issued and the page says so.

Each terms version has at most one invoice that isn't void (`simple_invoices.coaching_terms_id`, unique while not void, and it can't change). Replaying the same form returns the same invoice; a form for an older version is refused as out of date. Voiding the invoice allows it to be issued again. Issuing takes no payment: staff record the offline payment with the invoice's existing **Record offline payment** form, and the student sees the invoice under **Courses and invoices**. Each issue is in staff change history.

## Renewals ([#317](https://github.com/deepnative/deep-native-engine/issues/317))

Renewal is the renewal date an administrator set, nothing more. Nothing renews or charges automatically, and listing a renewal changes nothing.

- **Administrators.** The coaching administration page (`/operator/coaching`) has a **Renewals due** list: students whose _current_ terms have a renewal date that has passed or falls within the next 30 days (UTC), oldest first, each marked "N days overdue", "due today" or "due in N days" and linking to the student's page. Earlier versions, revoked accounts and accounts being deleted aren't listed. To renew, open the student and save new terms with the next renewal date.
- **Students.** Beside their renewal date on `/account/coaching`: "Nothing renews or charges automatically. To renew, contact info@deepnative.io."

No migration and no export change. Tests: RENEW317-01..04 in `tests/unit/coaching-terms.test.ts` and `tests/integration/coaching-terms.test.ts`.

## What this doesn't do

- The renewal date is shown and listed for administrators, never acted on: no automatic renewal, acceptance, charge, grant or invoice. There is no cancellation flow (#319).
- Nothing is invoiced automatically. An administrator issues a terms invoice on the student's page (#318). Monthly coaching hours and their invoices work as before ([MONTHLY-COACHING-INVOICES.md](MONTHLY-COACHING-INVOICES.md)).

Tests: TERMS316-01..07 in `tests/integration/coaching-terms.test.ts`; export index in `tests/unit/member-export.test.ts`. Allowance units: ALLOW27-01..08 in `tests/integration/coaching-allowances.test.ts` and `tests/unit/coaching-allowances.test.ts`; browser journey L330 in `tests/e2e/coaching-invoices.spec.ts`. TERMSINV318-01..06 in `tests/integration/coaching-terms-invoices.test.ts`, TERMSINV318-07 in `tests/unit/coaching-terms.test.ts` and browser journey L331 in `tests/e2e/coaching-terms-invoice.spec.ts`.
