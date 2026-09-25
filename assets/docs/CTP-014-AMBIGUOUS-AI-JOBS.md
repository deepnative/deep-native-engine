# Synthetic AI job ambiguity fence

This is the bounded private job-state slice of [CTP-014 #31](https://github.com/deepnative/deep-native-engine/issues/31), tracked by [#184](https://github.com/deepnative/deep-native-engine/issues/184). It does not connect an AI provider or expose a member-facing AI action.

An AI attempt can reach a provider before its worker sees a timeout, exception, or expired lease. Repeating that attempt could create a duplicate result or charge. A thrown AI adapter error records only `provider_outcome_unknown`; an explicit AI `provider_timeout` records that allowlisted code. Both move the job to `needs_reconciliation`, clear the lease and attempt token, and make it non-retryable. A worker that encounters an expired AI lease atomically makes the same transition without dispatching another attempt. The persisted idempotency key remains bound to the same request fingerprint: exact replay returns the held job, while a changed request conflicts. A delayed worker's completion cannot replace the held state or return its result as accepted.

This fence is deliberately conservative: a pre-dispatch AI exception may also need reconciliation. The system cannot tell whether the provider performed work from an exception alone. Existing non-AI adapters retain bounded retries and lease takeover. Existing AI invalid-response handling remains a separate retry path; a future live-provider integration must review that path before use.

Migration 019 adds the held state and safe error code while preserving existing rows. It is repeatable through `schema_migrations` and constrains held rows to AI timeout or unknown-outcome codes. It does not retroactively classify historical failures.

There is no automated release of a held job. Operator investigation, provider-operation identity, budget accounting, member consent, and any safe reconciliation or replay policy remain in CTP-014. A new idempotency key can create a distinct job; provider dispatch must remain disabled until those boundaries are designed and verified. This slice's tests use private synthetic data and real isolated PostgreSQL. It adds no approved browser journey because no user-facing route changes; the approved local scenario register and full-MVP denominator remain separate.

Rollback requires stopping workers first and preserving held rows for manual investigation. Do not reverse migration 019 while `needs_reconciliation` rows exist; the earlier status constraint cannot represent them.
