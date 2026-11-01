## Problem and resulting behavior

Describe the concrete issue and observable change. Link the issue; use `Refs` when acceptance criteria remain open.

## Scope and acceptance evidence

- Authorization, issue, accountable owner, and reviewer:
- Active issue claim link, worker/task ID, and aligned lifecycle/project status:
- Acceptance criteria with evidence links:
- Non-goals and remaining blockers:

## Validation

- Local tested commit/tree, environment, commands, exit statuses:
- `make verify` reports (repository and explicitly scoped application slice):
- Application unit metrics / E2E register and counts / critical journeys / required test results, or explicitly not implemented:
- Original local receipt/report hashes, runtime/group settings, and push reuse or fallback:
- Reviewed current head/base and resulting merge SHA/tree/parents (complete during delivery):
- Authorized Azure deployment/readiness evidence, if applicable; not a test-suite result:

## Review and handoff

- [ ] Full diff, generated dependencies, credentials/privacy, and failure paths reviewed.
- [ ] Complete local gate passed on the final clean push revision; intact original proof inspected and ordinary pre-push used, with no bypasses or hidden skips/retries.
- [ ] Changed combined source from an updated base was integrated and verified before merge; expected-head guarding does not lock the base.
- [ ] Acceptance evidence and docs/decisions are updated; remaining work is linked.
- [ ] Issue claim is handed off or released, and labels/assignee/project Status match the outcome; partial issue delivery uses `Refs` and stays open.
- [ ] Rollback/operations impacts are recorded where applicable.
- [ ] Required reviews and checks are satisfied; application, deployment, and commercial outcomes are stated separately.
- [ ] Delivery completed through merge to `main` and verification of the resulting main source/tree/parents, unless explicitly scoped to review/draft only.
