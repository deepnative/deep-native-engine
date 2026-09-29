# CTP-020 local event discovery boundary

The `events` member route reads the Git-versioned synthetic catalog in
`assets/docs/content/events/preview-events.json`. It does not create an event,
enrollment, attendance, reservation, payment, allowance, calendar item, recording,
consent or member-private event record. Browsing has no event database migration.
The fixture's sample capacity is deliberately **not** rendered as available seats.

The repository validator checks each fixture's fields, unique `(id, version)`
pair, canonical UTC start/end dates and lifecycle. A current upcoming version is
shown when its goal **or** one of its domain/IT interests matches the saved
member profile; `Explore other topics` shows all current upcoming versions.
Old versions remain addressable only by their exact URL and receive an
unavailable response when past, retired or replaced. Discovery never silently
moves a stale URL to a new version. If nothing matches, the page says so and
offers all-topic exploration. Expired/revoked sessions and staff-only identities
cannot reach personalized discovery.

The fixture dates are invented future samples, including the November 2030
Toronto daylight-saving change. The page always gives canonical UTC time and,
when a saved IANA zone is valid, the date-specific local conversion and offset.
Without a zone it links to the profile field rather than guessing. Each page
states that enrollment is unavailable and that access/cost, qualified expert
coverage and recording are unresolved. The fixture is not a clinic, booking
offer or proof of live capacity.

To change a sample, update the fixture and its behavioral tests together, keep
prior exact-version URLs truthful, and pass repository validation plus the full
local verification gate. To roll back this read-only discovery slice, revert its
Git commit and rebuild; no event rows need migration or reconciliation. A
future real enrollment service requires its own scoped issue, authority,
eligibility, qualified-capacity and policy decisions. This slice does not close
the broader CTP-020 acceptance criteria.
