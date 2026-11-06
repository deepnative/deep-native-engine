# Versioned monthly study and practice allowances (test units)

Delivered for part of [#199](https://github.com/deepnative/deep-native-engine/issues/199). A member can deliberately claim a finite monthly number of study-request test units at `/member/study-allowance`. These are not credits with money value. They don't call a paid AI service or represent a purchased plan.

## Policy

`study_allowance_policies` holds immutable versioned rows with the category, the limit per period, the period, who qualifies, the grant source, the provider rate estimate version and the spend state. Migration 099 adds `study-allowance-test-v1`: 5 study requests per UTC calendar month for any current member who claims them. The database only accepts a test source, no rate estimate and a test spend state, so a real provider-backed policy needs its own migration. The number 5 is a test figure, not a judgment about a real provider spend ceiling.

To change the rules, add a new version with a later `effective_from`. Existing rows can't be changed or deleted.

## Behavior

- Nothing is added until the member ticks an unticked confirmation and claims. Reading the page, or changing background or goals, adds nothing.
- A claim creates one ledger grant of exactly the current limit. It starts when claimed and ends when the month ends. Unused units aren't carried over and the existing expiry sweep records them.
- `study_allowance_claims` allows one claim per member, category and month, whichever version applied. An exact replay returns the original claim. Another key, tab or concurrent claim in that month creates no second grant. A key reused for a changed instruction conflicts.
- A form showing a superseded version or an earlier month is refused and nothing is added. A newer version never tops up a month that's already claimed.
- Units are used through the existing local test request flow.

## Switching it on

New claims need `DNE_LOCAL_TEST_UNIT_ISSUANCE=enabled` in demo or test mode, the same setting as the one-time study units. It's off by default and isn't enabled on the hosted site. While it's off, members can still read retained claims, but can't make new ones. Live mode has no route.

## Privacy

The structured export appends `studyAllowanceClaims` as section 57 in `local-member-records-v34`. It lists the claim, version, category, quantity, period and grant reference, and leaves out the operation key and workspace. Erasing the account removes claims and grants. Policy rows contain no member data and remain.

## Practice sessions

Delivered for part of #199 and #200. `mock-allowance-test-v1` is 3 practice sessions per UTC calendar month, with the same claim rules as study requests and its own monthly slot. The number 3 is a test figure.

`DNE_PRACTICE_SESSION_ALLOWANCE=enabled` makes starting a new private practice session use one claimed unit. It's off by default, off on the hosted site, and refused with the rest of live mode. While it's off, starts are free as before, the allowance page has no practice section unless a claim is retained, and practice claims are refused. Claims also need `DNE_LOCAL_TEST_UNIT_ISSUANCE`.

**Counting rule:** one unit per new session. The session and consumed unit commit together. Returning, an exact repeat, concurrent starts of one session, and all 15 response/comparison pairs (30 visible turns; instructions don't count) use nothing more. The delivered session is otherwise unchanged and the cap remains at 15 pairs. A refused start (no unit, ineligible or retired source, changed goal, withdrawn session) creates nothing and uses nothing. Withdrawing a session doesn't refund its unit or allow a restart. Sessions already started stay open when units run out or the month ends.

The sessions are the deterministic local comparison, not generated feedback or an interview mode. No provider is called, so "uses a unit" spends nothing. In the staff reconciliation report these units appear as consumed without an attachment, because there's no completion record for this category yet.

The export appends `practiceSessionAllowanceUses` as section 58 in `local-member-records-v35`: session, claim and time, without the reservation. Account erasure removes uses, claims and grants.

Rollback: unset the setting. Starts go back to free. Keep the additive table and ledger facts.

## Rollback

Turn the setting off to stop new claims. Keep the additive tables and ledger facts. Don't delete claims to reset a month, because that would allow a second grant.

## Still open on #199

Real provider rates and spend ceiling, optional-offer eligibility, renewal and cancellation rules, overrun policy and provider dispatch. On #200: generated feedback, its provider failure handling and interview mode.
