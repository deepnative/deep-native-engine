# Quality and AI-assisted development gates

These are planned requirements, not achieved measurements. No application or application test harness exists yet. Repository-tooling checks are available via `make verify`; their results do not establish application coverage or passing application tests. See [verification scope](../workflows/VERIFICATION.md).

The [current product direction](../PRODUCT-DIRECTION.md) broadens eligibility and learning/participation goals. Include [the expanded audience journeys](ECOSYSTEM-JOURNEYS.md) alongside the original applicable invariants; no silent denominator reduction is permitted.

## Coverage contract

- **Unit coverage:** at least 99% for each of statements, branches, functions and lines across first-party executable application source, including files not imported by tests. Enforce per logical module as well as globally so one module cannot conceal an untested one. Tests, generated/vendor artifacts and genuinely non-executable configuration may be excluded only through a visible reviewed allowlist. No exclusion of business logic, error handling, authorization, adapters, jobs, or UI behavior just to meet the threshold.
- **E2E coverage (confirmed by the user):** at least 99% of approved in-scope acceptance scenarios have an automated browser test that passes. Numerator is passing scenario IDs; denominator is the versioned approved scenario register, including pending/unimplemented scenarios for the target release. A scenario counts once regardless of test count. Unmapped, skipped, quarantined, failed, or retry-only successes do not count. With fewer than 100 scenarios, a 99% target normally means all must be covered. Report scope, numerator, denominator, and uncovered IDs.
- **Critical E2E:** 100% coverage and pass for privacy/isolation, authorization/revocation, money and subscription dates, entitlements/concurrency, consent, billing event order, AI budget/failure, deletion, and the complete member-to-reviewer journey. All executed required tests must pass; 99% is never permission for a 1% failure rate.
- E2E scenario coverage and application code coverage are different measurements. Browser code coverage may help find gaps but does not prove end-to-end behavior. Do not silently call a pass rate or UI line metric journey coverage.
- Early slices report coverage against their explicitly approved slice register plus the outstanding full-MVP register. They cannot claim the full Phase B gate. Zero collected tests, missing reports, or an empty denominator fail the gate rather than returning a passing percentage.

## Required checks before every push

Once implementation starts, one documented local verification command must run formatting/lint, type checks, unit coverage, integration tests, the applicable complete E2E matrix, production build, and relevant security checks. Database/provider contract tests exercise actual transactional state; deterministic adapters replace external services, not the application's own business logic. Document how bootstrap commits are verified before the final harness exists; no untested application push is permitted.

Capture revision/tree identity, environment, exact commands, exit status, raw coverage counts, scenario mapping, and reports. Any code change after validation invalidates evidence for the previous tree. No bypass, threshold reduction, silent exclusion, fake assertions, or skipped-test acceptance. CI independently repeats checks on the proposed merge and uses real observed job names for required checks. Do not enable repository rules referring to nonexistent jobs.

## Test design

Use examples derived from acceptance criteria, not from the generated implementation alone. Exercise happy paths, validation, unauthorized access, missing data, failure and recovery. Test money in integer cents; date boundaries including leap years/end of month/DST; idempotency and duplicate/out-of-order events; transaction races; revoked and expired grants; asynchronous jobs and page reloads; retained records and derived-data deletion. Use property-based or targeted mutation checks where they meaningfully challenge invariants.

Browser tests use isolated synthetic users/data, deterministic clocks where appropriate, accessible locators and observable outcomes. They run the real application, server and database. Stub only external provider boundaries. Avoid arbitrary sleeps and coupled tests. Preserve traces for failures. Reproducibility and first-attempt failures are reported separately from reruns; retries cannot conceal flakiness.

## AI-assisted development working agreement

Issue first → inspect context → identify risks and design → define failing behavioral evidence → implement a small slice → verify before push → review the diff → CI → merge to main → verify main CI → evidence-backed closure. Keep decisions and next-session context durable. Validate APIs and dependency versions against official documentation, use lockfiles, and review generated dependencies/code and licenses. Prefer simple maintained architecture; do not add speculative services.

Treat uploaded/retrieved content as untrusted data. Keep secrets and private member/client content out of model prompts and generic logs. Use explicit tool/provider permissions, synthetic fixtures, cost limits, and bounded failure recovery. Human review remains necessary for assessments and sensitive business decisions; model-generated text is not independent verification.

## Definition of ready and done

Ready means approved scope, observable AC, resolved prerequisites, a named accountable owner before execution, known data/privacy boundary, a test/evidence plan, and no unanswered decision that blocks the slice. Current backlog status does not authorize implementation.

Done means every AC is evidenced; intended-revision tests passed before push; CI passed; meaningful review findings are resolved; docs, migrations/rollback and operations are updated where relevant; no undisclosed skipped work or P0/P1 defect remains. Planning/operations issues use reviewed documents and actual recorded business evidence instead of fabricated code coverage. A phase gate closes only after all required child outcomes are met.

## Official references checked for this plan

- [GitHub responsible agent use](https://docs.github.com/en/copilot/responsible-use/agents): review and validation of AI-generated work.
- [Playwright best practices](https://playwright.dev/docs/best-practices): test observable behavior and isolate tests.
- [Vitest coverage configuration](https://vitest.dev/config/coverage.html): inclusion and coverage threshold controls; exact tool/version selection is deferred to architecture implementation.

The 99% thresholds are the user's project requirement, not thresholds prescribed by these sources.
