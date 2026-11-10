# Student coaching terms

**Issue:** [#316](https://github.com/deepnative/deep-native-engine/issues/316), under Tom's [#35](https://github.com/deepnative/deep-native-engine/issues/35). Owner decisions of 9 November 2026.

There is no fixed coaching offer. A platform administrator sets each student's terms on the student's page under **Administration → Monthly coaching** (`/operator/coaching/<student>`):

- price (CAD), which is the student's own coaching price and covers their allowances;
- start and end date of the coaching period, and the renewal date;
- allowances: expert review minutes, coaching sessions and AI requests.

Each save is a new version (migration 126, `coaching_terms`). Earlier versions can't be changed or deleted. A form opened before someone else saved is refused as out of date (409), and the same operation replayed returns the same version. Saves need a platform administrator, the page's CSRF token and the site's own origin.

The student sees their current terms, read-only, on **Monthly coaching hours** (`/account/coaching`), with: "There are no cancellation or refund rules. To ask about changes, contact info@deepnative.io." Every version is in Download my records (`coachingTerms`, export v45), without the administrator. Deleting the account removes them.

## Renewals ([#317](https://github.com/deepnative/deep-native-engine/issues/317))

Renewal is the renewal date an administrator set, nothing more. Nothing renews or charges automatically, and listing a renewal changes nothing.

- **Administrators.** The coaching administration page (`/operator/coaching`) has a **Renewals due** list: students whose _current_ terms have a renewal date that has passed or falls within the next 30 days (UTC), oldest first, each marked "N days overdue", "due today" or "due in N days" and linking to the student's page. Earlier versions, revoked accounts and accounts being deleted aren't listed. To renew, open the student and save new terms with the next renewal date.
- **Students.** Beside their renewal date on `/account/coaching`: "Nothing renews or charges automatically. To renew, contact info@deepnative.io."

No migration and no export change. Tests: RENEW317-01..04 in `tests/unit/coaching-terms.test.ts` and `tests/integration/coaching-terms.test.ts`.

## What this doesn't do

- Allowances are agreed numbers shown to the student. They don't mint test units or grants (#27); the existing review and support grant tools are unchanged.
- The renewal date is shown and listed for administrators, never acted on: no automatic renewal, acceptance, charge, grant or invoice. There is no cancellation flow (#319).
- Invoices are unchanged; monthly coaching hours and invoices work as before ([MONTHLY-COACHING-INVOICES.md](MONTHLY-COACHING-INVOICES.md)).

Tests: TERMS316-01..07 in `tests/integration/coaching-terms.test.ts`; export index in `tests/unit/member-export.test.ts`.
