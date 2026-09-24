# CTP-023: adapter completion belongs to one attempt

[Delivery #142](https://github.com/deepnative/deep-native-engine/issues/142) is a bounded synthetic QA-004 M08 regression and repair under [#42](https://github.com/deepnative/deep-native-engine/issues/42). Accountable owner: Tom Wu / @tomqwu. The delivery receives self-review; no independent or qualified security approval is claimed.

## Behavior and invariants

The job store already prevents a stale attempt token from changing a newer attempt. However, `succeed` returns current job state when its conditional update is rejected. Previously, `runAdapterJob` attached the old provider result to that state, even if a replacement worker was running, exhausted or successful. Lost-acknowledgement recovery also accepted any succeeded state as proof of the old invocation's completion.

The runner now returns its provider result only when the persisted status is `succeeded` and its attempt count equals the claim's count. Claims atomically increment this count; terminal success cannot be claimed again. The existing token check protects the write, while the generation check protects the returned result. No database migration or public route changes.

A superseded runner returns the current job with `result: null`. `executed: true` still means its provider invocation happened; it does not mean its result was accepted. A lost acknowledgement is recovered only when the same successful attempt is confirmed. Missing, unavailable or unrelated proof raises the fixed `Could not confirm adapter job completion.` error without exposing the database exception or rewriting state as provider failure.

## Reproduction and verification

On 24 September 2026, baseline main `39382b6c6630ec57750bdb25035ea60bec01a3ff` passed `make verify`: 48 repository tests, 311 unit, 39 PostgreSQL integration and 108 browser executions (54 local journeys, 53 critical). Environment: macOS, Node 26.9.0, Python 3.14.7; dependencies restored from the lockfile before this slice.

Before the fix, the added focused job suite failed six cases: four returned superseded results, one misattributed a newer success after a lost acknowledgement, and one exposed a synthetic database error during reconciliation. The full integration suite failed four new takeover cases while its other 40 cases passed. The disposable integration launcher initially had a CommonJS import error; that launcher was corrected before database reproduction. An initial type check caught an ES2024-only test helper, which was replaced with ordinary promises to retain the existing ES2023 target. None of those failures counts as acceptance evidence.

| Acceptance | Observable test evidence |
| --- | --- |
| Suppress superseded results | Job unit tests exercise running, failed, exhausted and succeeded replacement states; none returns the old result or calls the failure transition. |
| Prove real takeover | Integration holds the first synthetic invocation with an explicit promise, expires its persisted lease and claims attempt two through a separate PostgreSQL pool. It releases the first invocation only after the replacement is running, succeeded or exhausted, then verifies no result and unchanged persisted state. No wall-clock sleep or test retry is used. |
| Recover only this completion | Unit and PostgreSQL tests distinguish the original committed success with a lost acknowledgement from another attempt's success. Only the original result is recovered. |
| Honest unavailable proof | Missing state and a rejected reconciliation query produce the fixed unconfirmed error; raw error text and the result are not returned. |
| Preserve the shared gate | Final exact-commit local, pre-push, PR and main CI evidence, raw coverage counts, revision/tree and cleanup are recorded on #142 and its linked PR. Existing browser register stays `initial-learning-v22`, 54/54 journeys and 53/53 critical, with the full-MVP denominator unchanged. |

Focused checks after the repair passed all 38 job unit tests and 44 PostgreSQL tests. The complete required gate is the acceptance authority, not this focused subset. No new browser scenario is added because this internal runner has no user-facing route; the existing complete browser gate remains required.

## Limits and rollback

All adapters remain synthetic. This does not prevent a live provider side effect from happening twice after lease expiry, store/retrieve provider results, reconcile an external ambiguous effect, introduce lease renewal, or establish full-MVP/AI reliability. Those provider-specific controls remain under #31/#32 and the broader #42 matrix before live use. The test deliberately lets an expired first invocation finish to verify that its result is suppressed after takeover.

Rollback is a code revert with no schema migration, but would reintroduce the demonstrated result attribution defect. No deployment, provider activation, paid service or qualified review is authorized by this delivery. Next bounded work should follow the live board and claims; #140's dependency prerequisite is owned by @netcsc (lead GPT-6 Sol/high, review Astra/high when needed) and must not be duplicated.
