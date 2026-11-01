# Acceptance and verification evidence

- Issue / PR / accountable owner / independent reviewer:
- Scope and authorization (planning, tooling, application slice, release):
- Local tested commit/tree / clean or dirty / original report and receipt hashes:
- Merge SHA / actual main tree and parents / local synchronization:
- Merged delivery branch/worktree cleanup or safety blocker:
- Date, OS, runtime/dependency versions:
- Commands and exit statuses / original report links:
- Gate owner and process/session / actual terminal state:
- Runtime, allocated CPU/RAM, selected group count and isolated fixture identity:
- Full-gate start/end/duration / protected-push duration / receipt reused or full fallback:
- Azure deployment run/revision/readiness and public journey, only when authorized (not a test run):

| Acceptance criterion / BDD scenario ID | Observable result | Executable test or artifact evidence | Remaining gap |
| --- | --- | --- | --- |
| Criterion and stable Given/When/Then scenario | Actual observed behavior | Test file/name, result and applicable approved journey ID; artifact/decision for non-application work | Explicitly none or unresolved |

- Missing behavior: first failing behavioral test command, revision, expected/actual outcome and subsequent passing evidence:
- Already delivered scenarios: actual baseline evidence, no fabricated failure:
- Scenario mapping covers mandatory variants; prose alone does not establish application acceptance:

For application work, record unit raw covered/total counts for each metric and module; E2E register version, passing/total scenario IDs, critical coverage, uncovered/skipped/retried IDs; first-attempt required test results; build and integration results. For planning/tooling, state application metrics are not applicable and not achieved.

- Provider states: simulated / manual / configured / test-verified / live-verified:
- Review findings resolved / unresolved:
- Rollback and operational implications:
- Follow-ups and decision (ready for review, blocked, accepted; who decided):
- Next bounded issue or owner decision, why next, dependencies/claim status, and recommended lead model/starting effort plus applicable design/review settings (recommendation only):

## Completed milestone demo

- Product slice/milestone or documentation/tooling artifact shown:
- Demonstrated revision / date and timezone / environment and provider state:
- Direct preview access and restart instructions (availability/lifetime):
- Main user journey: actions taken and actual observed outcomes:
- Useful screenshot/video/artifact links (invented data; no credentials/private files):
- Dedicated preview fixture/resources; confirm no active gate database/server was used:
- Changed README capabilities, or not applicable for documentation/tooling:
- Limitations / unavailable-access blocker, owner and next action:
- Parent/qualified/full-MVP/deployment state (distinct from this demo):

Use the [shared local verification playbook](../workflows/LOCAL-VERIFICATION-PLAYBOOK.md). Timings are dated observations, not guarantees; preserve failed campaigns separately and do not manufacture CI test evidence.
