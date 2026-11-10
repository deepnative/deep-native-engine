# Student coaching terms

**Issue:** [#316](https://github.com/deepnative/deep-native-engine/issues/316), under Tom's [#35](https://github.com/deepnative/deep-native-engine/issues/35). Owner decisions of 9 November 2026.

There is no fixed coaching offer. A platform administrator sets each student's terms on the student's page under **Administration → Monthly coaching** (`/operator/coaching/<student>`):

- price (CAD), which is the student's own coaching price and covers their allowances;
- start and end date of the coaching period, and the renewal date;
- allowances: expert review minutes, coaching sessions and AI requests.

Each save is a new version (migration 126, `coaching_terms`). Earlier versions can't be changed or deleted. A form opened before someone else saved is refused as out of date (409), and the same operation replayed returns the same version. Saves need a platform administrator, the page's CSRF token and the site's own origin.

The student sees their current terms, read-only, on **Monthly coaching hours** (`/account/coaching`), with: "There are no cancellation or refund rules. To ask about changes, contact info@deepnative.io." Every version is in Download my records (`coachingTerms`, export v45), without the administrator. Deleting the account removes them.

## Invoicing the terms (#318)

On the same page, **Invoice these coaching terms** issues one invoice for the current terms version ([#318](https://github.com/deepnative/deep-native-engine/issues/318), migration 131):

- one line, "Coaching · <start> to <end> · terms version N", at the terms price;
- configured invoices are from Deep Native Inc. with 13% HST computed by the server and the e-Transfer/cheque wording (`src/invoice-issuer.ts`, #797); sample mode asks for an invented tax instead;
- billed to the student's saved billing recipient (name, email, optional company). Until the student saves one on **Billing recipient**, nothing can be issued and the page says so.

Each terms version has at most one invoice that isn't void (`simple_invoices.coaching_terms_id`, unique while not void, and it can't change). Replaying the same form returns the same invoice; a form for an older version is refused as out of date. Voiding the invoice allows it to be issued again. Issuing takes no payment: staff record the offline payment with the invoice's existing **Record offline payment** form, and the student sees the invoice under **Courses and invoices**. Each issue is in staff change history.

## What this doesn't do

- Allowances are agreed numbers shown to the student. They don't mint test units or grants (#27); the existing review and support grant tools are unchanged.
- The renewal date is shown, not acted on. Renewal and acceptance stay with #317; there is no cancellation flow (#319).
- Nothing is invoiced automatically, on the renewal date or otherwise. Monthly coaching hours and their invoices work as before ([MONTHLY-COACHING-INVOICES.md](MONTHLY-COACHING-INVOICES.md)).

Tests: TERMS316-01..07 in `tests/integration/coaching-terms.test.ts`; TERMSINV318-01..06 in `tests/integration/coaching-terms-invoices.test.ts`, TERMSINV318-07 in `tests/unit/coaching-terms.test.ts` and browser journey L330 in `tests/e2e/coaching-terms-invoice.spec.ts`; export index in `tests/unit/member-export.test.ts`.
