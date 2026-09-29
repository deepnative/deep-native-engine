# CTP-014: exact-source permission for local AI simulation

Issue [#341](https://github.com/deepnative/deep-native-engine/issues/341) is a bounded local prototype under open parent [#187](https://github.com/deepnative/deep-native-engine/issues/187). It lets a member choose one invented, owned, clean text-evidence version for one fixed local-simulation purpose. The statement and receipt are specific to this prototype. Neither review consent nor circle sharing implies AI permission. Production wording, provider retention, region, pricing and live dispatch remain unresolved on the parent.

## Data and authorization boundary

- The member sees the source version and a local-only statement before granting. The server fixes the purpose and statement version; it does not accept an arbitrary prompt, destination, provider or purpose from the browser.
- A receipt records identifiers, source digest and revision, actor, purpose, statement version and grant/withdrawal times. It contains no source bytes, prompt, credentials or output. A job references the receipt and exact source fingerprint, and exposes a safe status and deterministic simulation result only.
- The source must remain owned by an active member, clean, text/plain, current and outside deletion. Creating a revision permanently withdraws its parent's local permission and cancels unfinished linked jobs; deleting the newer revision does not restore the old grant. The owner can also withdraw a retained receipt when its source is no longer current or clean. New revisions need a fresh receipt. The server checks both at queue time and immediately before the local adapter receives bytes. The loaded buffer must match the locked source digest and size.
- Queue and dispatch lock local platform control first; the shared authorization lock order is principal, workspace, evidence, receipt, then job. Grant, withdrawal, dispatch and deletion use compatible ordering so whichever operation obtains the relevant locks first determines the outcome. A durable job attempt precedes dispatch; an ambiguous outcome is held for reconciliation rather than retried blindly.
- General member-owned AI jobs cannot bypass this permission path. Live mode has no member private-evidence AI dispatch path. A registry must return a demo/test AI adapter with the matching mode before source bytes are handed to it. Deterministic demo/test execution makes no network request.

## One unresolved local job per receipt and purpose

Under parent [#31](https://github.com/deepnative/deep-native-engine/issues/31), a different idempotency key conflicts while the exact receipt and purpose already have a `pending`, `running`, `failed` or `needs_reconciliation` job. The fixed conflict response contains no source or job metadata. Exact-key replay still returns the original job when its member, receipt and fingerprint match, including when a legacy duplicate row exists. A changed fingerprint or foreign key remains a conflict. Demo and test modes share the same receipt fence.

The persisted check and insertion run while holding the existing receipt `FOR UPDATE` lock, so separate workers serialize without a schema migration or in-memory coordination. Once all prior jobs are known terminal (`succeeded` or `exhausted`), a new key may enqueue only after fresh source, receipt, member, workspace and platform-control checks. A failed job at its attempt limit remains fenced until the existing run path records exhaustion. No held outcome is automatically released or retried.

Previously created duplicate jobs remain intact: any unresolved row prevents another new key, and replay does not rewrite historical or unknown outcomes. This change does not reconcile or cancel legacy duplicates and cannot prevent writes from older application versions or direct database access. Stop older workers before rolling out the changed application; rolling it back reopens the distinct-key enqueue gap. Provider identity, budgets, production consent and live retry policy remain outside this local simulation boundary.

## Deletion and rollback

The local receipt and its linked jobs are removed when the owning evidence or workspace is deleted. Withdrawal retains a content-free historical receipt while the source remains, and prevents future dispatch; it cannot recall an already completed local computation. Migration 039 adds local-only receipt linkage and can be rolled back only after dependent jobs and receipts have been removed. Evidence files remain in the existing private object store and are never copied to job metadata.

## Acceptance evidence

The approved local browser journey is L76. Real PostgreSQL tests cover replay/conflict, simultaneous distinct keys, persistence across new connection pools, legacy duplicates, known terminal transitions, ownership, stale versions, quarantine and revocation, both lock orderings, deletion and uncertain attempts. The single-unresolved-job change adds no browser interaction or approved journey. `make verify` reports the local slice separately from outstanding full-MVP coverage. Passing simulation checks do not establish qualified review, production consent or provider-side erasure.
