# Private circle membership recovery

Scope: [#467](https://github.com/deepnative/deep-native-engine/issues/467), under privacy parent #42. This is a private invented-data preview, not a live community or full-MVP acceptance.

Browse local circles, join, leave and rejoin. A repeat join preserves the current generation; a genuine rejoin opens a new generation while retaining closed membership intervals. Current membership and historical participation remain distinct.

## Unconfirmed completion

A join or leave may commit before its reply arrives. The unconfirmed page contains no private membership payload or resubmission form. Use **Check current membership** to make a fresh authorized read before deciding whether another action is needed. Nothing is replayed automatically. An expired or revoked session must regain valid access; the recovery link does not grant authority. A read alone never changes membership history.

## Lifetime and locking

The existing bounded transaction engine limits acquisition to three seconds, each operation to five seconds and the whole operation to ten seconds, further shortened by conservatively observed database expiry. It withholds results after expired COMMIT acknowledgement or native connection handback. Pending commands receive no queued rollback; connections are discarded, including late acquisitions, without automatic replay.

Joining serializes circle seats before acquiring the member principal update fence and workspace share fence. Listing and leaving acquire principal and workspace share fences. Leaving deliberately does not acquire the circle advisory lock, so an existing membership can close while another join waits for seats. Capacity, immutable closed intervals, export and erasure semantics remain unchanged.

## Verification and rollback

Permanent PostgreSQL/HTTP scenarios cover list, join and leave across delayed successful COMMIT and handback, exhausted acquisition and unresolved query/COMMIT/rollback replies. Browser journeys L157–L159 cover three learner backgrounds on desktop and mobile, ordinary membership changes and uncertain join/leave followed by read-back without history replay. Execution evidence belongs on the issue; this description alone is not a gate pass.

No schema migration or historical rewrite is introduced. Before rollback, pause affected endpoints and drain requests. Preserve committed membership generations and closed intervals; do not replay unconfirmed actions or rewrite history. Previous code can read the schema but reopens the demonstrated late-response defect, so keep affected endpoints unavailable until a bounded correction is verified.

Delivery requires exact-commit local and pre-push verification, author review, PR and resulting-main CI, branch cleanup and a separate isolated demonstration. Parent #42 remains open for other acceptance areas.
