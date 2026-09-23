---
name: "Delivery issue"
about: "Define a bounded outcome with acceptance criteria and evidence"
title: "[ID] Observable outcome"
labels: "status:backlog"
assignees: ""
---

## Outcome and authorization

Stable ID, phase/epic, accountable owner, current authorized scope, and non-goals. Backlog status alone is not permission to implement.

## Work claim and coordination

Use the live assignee, one lifecycle label and matching project Status. Before work, record the worker/task ID, timestamp, bounded scope, branch/PR and next checkpoint; check for existing or competing claims. Follow `assets/docs/workflows/ISSUE-COORDINATION.md`. Update this claim at review, blockers, handoff and completion; release partial claims explicitly.

## Dependencies and readiness

List prerequisite issues, decisions, data/privacy boundaries, provider states, and stop conditions. State the self-review and test/evidence plan before execution; name a separate reviewer only when requested or required.

## Acceptance criteria

- [ ] Given a concrete starting state, an action produces an observable outcome.
- [ ] Applicable failure, recovery, privacy, and boundary scenarios are covered.

## Model recommendation

Select one `model:*` label and reasoning effort. Add separate review/design/escalation labels as needed using the repository model policy. Labels do not assign agents.

## Verification evidence

List commands, behavior-based tests, scenario IDs, expected artifacts, and review decisions. Application work follows the repository's 99% unit / 99% E2E journey / 100% critical-and-pass gates; planning work uses document evidence without invented coverage.

## Definition of done

- [ ] Every AC has linked evidence; unresolved external prerequisites are explicit.
- [ ] Required checks passed on the intended revision before push and in CI.
- [ ] Current diff and evidence self-reviewed and recorded; blocking findings resolved and any actually required separate review completed.
- [ ] Docs, decisions, handoff, and relevant rollback/operations records updated.
- [ ] Work claim, assignee, lifecycle/blocker labels and project Status reflect the actual outcome; partial delivery stays open.
- [ ] Scope was authorized by the accountable owner; no repeat merge approval or inferred live/commercial readiness.
