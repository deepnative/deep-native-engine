# CTP-004: deterministic adapters and configuration boundaries

Issue [#23](https://github.com/deepnative/deep-native-engine/issues/23) adds a provider boundary without connecting a live provider. The local product remains a dynamic Express/PostgreSQL application. AI, payment, storage, calendar, email, authentication and analytics are explicit adapter kinds with separate demo, test and live configuration states.

## Runtime modes

`DNE_APP_MODE` is `demo` by default. The local preview accepts only `demo` and `test`; hosted live startup still requires its separately authorized configuration slice.

| Application mode | Database boundary | Adapter behavior | Credentials |
| --- | --- | --- | --- |
| `demo` | Loopback `dne_dev` or `dne_demo` | Deterministic simulated result | None read or required |
| `test` | Loopback random `dne_test_<32 hex>` | Deterministic simulated result | None read or required |
| `live` | Non-loopback live-only database validator | Readiness is configured or disabled; no provider call is implemented | Dedicated `DNE_LIVE_*` names only |

Each adapter may request a mode with `DNE_<KIND>_MODE`. A cross-environment request is disabled. Missing live variables return their variable names as an actionable configuration state without returning supplied values. Demo impersonation is off by default and is rejected in live mode.

`/readiness` shows the local/test environment and every adapter state. A simulated state explicitly says that no external side effect occurred. It does not claim that a message was sent, a payment happened, an object was stored or a provider was verified.

## Synthetic fixtures

`src/demo-seed.ts` contains labelled `.invalid` records for general, non-IT professional and IT learners, multiple goals, foundation and test-coaching membership states, and assigned/revoked coach plus reviewer, editor, moderator and operator roles. They are deterministic fixtures, not login credentials, live identities, qualified capacity or payment evidence. Identity/authorization implementation remains in CTP-005.

## Durable adapter jobs

Migration `002-adapter-jobs.sql` stores adapter kind, environment, operation, an idempotency key, a one-way request fingerprint, status, bounded attempt count and an allowlisted safe error code. It does not store request payloads, credentials or raw provider errors. Enqueueing the same request with the same idempotency key returns the existing job; changing that request under the same key fails closed.

Workers claim a persisted job by ID with an atomic, time-bounded lease before invoking an adapter. Only one concurrent worker can own an attempt. A worker may retry a failed job or recover an expired lease until the configured attempt bound is reached; after that, the job becomes `exhausted` and cannot invoke the adapter again. Success and failure transitions require the active attempt token, so a late worker cannot replace a terminal result. A new database connection can resume this lifecycle after an application restart.

## Failure and recovery

- Invalid environment names, shared test databases, live/demo database crossover and live demo impersonation fail closed.
- Missing live settings disable only the affected adapter and name the missing configuration.
- Raw exceptions are converted to `provider_unavailable`, `provider_timeout` or `invalid_provider_response` before persistence.
- Repeated or concurrent execution cannot exceed the job's configured attempt bound, and duplicate workers cannot invoke the same active attempt.
- Adapter execution resolves through the application registry. Live, mismatched and disabled adapters are rejected before a job is enqueued, claimed or invoked.
- A configured live state means required settings are present. Provider verification, deployment and real effects remain separate outcomes.

## Acceptance evidence

- Unit contracts cover every adapter kind, environment/mode mismatch, missing/complete live configuration, secret redaction, database isolation, synthetic fixture coverage, deterministic output and job failure/success branches.
- PostgreSQL integration covers migration idempotency, failure survival across connections, concurrent attempt bounding, safe errors and simulated completion.
- Journey `L14` checks the compiled readiness page in desktop and mobile Chromium. It requires all seven providers to be labelled simulated with no live-configured claim.
- The shared gate retains per-file and global 99% unit thresholds, all existing journeys, the 27-item outstanding full-MVP register, zero retries/skips and exact-revision verification.

No provider account, credential, outbound message, payment, upload, analytics event, deployment or real member record is part of this issue.
