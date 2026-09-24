# CTP-014: synthetic adapter result validation

[Issue #145](https://github.com/deepnative/deep-native-engine/issues/145) delivers the internal demo/test result boundary of [CTP-014 #31](https://github.com/deepnative/deep-native-engine/issues/31). It follows [#142's attempt-result fence](CTP-023-ATTEMPT-RESULT-FENCING.md). It does not select or call an external provider, spend an allowance, send member evidence, or verify a live response schema.

## Contract and behavior

Before marking a claimed job successful, the runner checks the returned value as untrusted runtime data. It must be an object with own data fields for the expected adapter kind, the current `demo` or `test` mode, and `simulated` state. `reference` is an opaque ASCII token of 1–128 characters: it begins with an alphanumeric character and may then contain alphanumerics, `.`, `_`, `:`, or `-`. `message` is 1–240 UTF-16 code units of visible, single-line text, without leading/trailing whitespace or Unicode control/format characters. These bounds contain the existing deterministic adapter outputs. Accessor fields, wrong or missing types, wrong kind/mode/state, arrays and primitives fail. Only the five named fields are copied to the caller; extra properties are never read or returned.

An invalid value never calls the success transition. The active attempt instead uses the existing `invalid_provider_response` failure code and configured retry/exhaustion limit. Neither raw output nor an exception derived from it is stored in the job row or returned to the caller. A thrown adapter error keeps the separate `provider_unavailable` path. The successful result still belongs only to the same persisted attempt; a replacement worker's state cannot acquire an older result, and ambiguous completion still requires same-attempt proof.

## Reproduction and evidence

Before the boundary change, 17 new job unit checks failed: malformed values were marked successful or returned, and a hostile accessor could throw raw text. Two new real-PostgreSQL cases failed because malformed responses succeeded. The new cases cover null, arrays, primitives, missing/wrong fields, kind/mode/state mismatches, reference/message limits and control characters, hostile property descriptors, allowlisted output projection, retry exhaustion, and recovery on a later valid attempt. The existing deterministic adapter, lease-takeover and ambiguous-completion tests remain required. This internal job runner has no new user-facing route, so the complete existing browser matrix is retained without adding a local scenario ID.

The change has no migration. Revert would restore the demonstrated malformed-result success path. Full AI consent, paid reservations/budgets, retrieval and tool isolation, external provider schemas, live activation and full-MVP browser evidence remain open under #31, #42 and [QA-002 #94](https://github.com/deepnative/deep-native-engine/issues/94).
