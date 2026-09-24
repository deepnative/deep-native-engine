# CTP-023: private repository failure diagnostics

24 September 2026. Owner: @tomqwu; worker: Codex root task. [Delivery #139](https://github.com/deepnative/deep-native-engine/issues/139) is the next owner-authorized M18/M19 slice of [CTP-023 #42](https://github.com/deepnative/deep-native-engine/issues/42), following [application-runner repair #137](https://github.com/deepnative/deep-native-engine/issues/137).

## Reproduction and behavior

The clean `a8168291da51653700dad9b01c8d381d2fe9dd56` baseline passed `make verify`. The first new exception/input probes then failed on unchanged runner code: raw OSError, ValueError, KeyError, subprocess and GateError messages disclosed a synthetic private value in the report/console; RuntimeError and an exception whose string method rejects inspection escaped; an unsupported filename was also printed. The initial fixture cleanup was moved ahead of each input subcase so one failing path assertion could not contaminate later link/dependency probes. These failures are reproduction evidence, not a passing gate.

The Python runner now distinguishes explicitly public, code-owned gate reasons from untrusted exceptions. Unexpected errors get a fixed verification-stage or CLI diagnostic without reading `str(error)`, arguments or a traceback. The `require` helper's message contract permits only code-owned text and opaque references. Input-derived paths, links and planning IDs use `ref-sha256:` plus the first 12 hex characters of SHA-256 over the string's UTF-8 bytes with surrogatepass; the reference is a local debugging identifier, not encryption or a secret identifier. Scanner rule/line information is retained. Fixed allowlisted role/skill names and missing required-file lists remain readable.

The runner captures Git stderr so failures cannot bypass its diagnostic boundary. Unknown command arguments are not echoed. Final report creation/write failures return a nonzero status and a fixed warning; they cannot turn an otherwise successful run into a pass. Any older report is stale when the current command fails or says it could not write evidence. Keyboard interrupts and other BaseException control flow are not converted to success.

## Acceptance evidence

| Criterion | Observable regression |
| --- | --- |
| Untrusted exceptions stay private | [Repository tests](../../tests/repository/test_repo.py) cover seven exception forms at verification and CLI boundaries, including an exception that must never be stringified; report/console exclude the synthetic value and status remains failed |
| Intended gate errors remain useful | Disposable invalid path, broken local link and unknown dependency cases retain their specific reason and opaque reference without publishing the input; source scanner retains rule, line and a stable reference |
| Real CLI boundaries fail safely | Unknown argument and invalid Git directory subprocess probes exit 1 with no private marker or traceback |
| Report failure cannot pass | Injected write failure is tested after both an earlier error and otherwise successful mocked checks; output never says PASS |
| Existing guarantees remain | Source/artifact marker, archive integrity, skipped-test, wrong-revision, threshold and pre-push regressions remain in the 48-test repository suite; full application gate runs separately |

Tooling tests do not claim application coverage or live-provider behavior. Exact clean commit/tree, `make verify`, unbypassed pre-push, self-review, PR/main CI, merge and branch cleanup results are recorded on #139. No application coverage exclusions, thresholds, approved journeys or retry settings change.

To identify a referenced input locally, compute the documented digest from the repository-relative POSIX filename, link target or planning ID being inspected; do not publish private values in a CI log to resolve a reference. Unexpected failures identify the verification stage; inspect the relevant local configuration or synthetic fixture without adding raw exception logging.

## Verification environment correction

The first clean-commit gate passed, but its pre-push repeat stopped on the existing welcome/style HTTP test with `socket hang up` (310/311 unit tests). Inspection found local Supertest 7.2.2 installed despite the committed manifest/lock requiring 7.3.0; `npm ls supertest --depth=0` reported the installation invalid. `npm ci` restored 7.3.0 and a subsequent `npm ls` confirmed it. The precise transport cause is not claimed from this correlation. Acceptance requires fresh full gates after this environment correction, not a retry of the unchanged environment. [QA-003 #140](https://github.com/deepnative/deep-native-engine/issues/140) tracks a prerequisite to reject stale installed dependencies before tests. No dependency manifest or application assertion was changed to resolve this failure.

## Remaining scope

Unittest failure traces and inherited npm/test-process output are separate emitters and are not filtered by this repair. Compressed artifacts, hosted/provider logs, backups, analytics and prompts also remain outside it. The source/artifact scans and the wider #42 matrix remain required; full-MVP and release acceptance are outstanding. There is no deployment, provider integration or schema migration. Rollback is a scoped revert followed by the complete gate.

Next bounded candidate: [QA-003 #140](https://github.com/deepnative/deep-native-engine/issues/140), preventing the observed stale-installation gap before another verification run. Recommend GPT-6 Sol/high, with Astra/high for separate review when requested or required. No owner decision or competing claim is required; this recommendation does not claim the work. M18 inherited-output probes remain on #42 afterward.
