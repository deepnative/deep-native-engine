# Contributing

Read [AGENTS.md](AGENTS.md), then follow [the team workflow](assets/docs/workflows/TEAM-WORKFLOW.md). Begin with an authorized issue and a small `codex/` branch. Preserve source provenance and other contributors' work.

Claim the issue before editing: check existing ownership, assign the agreed owner, apply `status:in-progress`, set project In progress and record your task/branch and scope. Re-read to detect competing claims. Follow [issue coordination](assets/docs/workflows/ISSUE-COORDINATION.md) for review, blockers, handoff and release; update the live status when the task ends.

```sh
make setup
make verify
```

Commit your changes, then run `make verify` again on the intended commit before pushing. The installed pre-push hook also checks the pushed revision and reruns verification. Use the PR template to record evidence and request review. CI is required evidence, not a substitute for local checks. Complete authorized delivery by merging the reviewed PR into `main` after required reviews and checks pass, verify the resulting main CI, and record the merge SHA. The owner has provided standing authorization for this step; do not stop at a draft unless explicitly requested.

See [verification and hook recovery](assets/docs/workflows/VERIFICATION.md) for prerequisites, failures and application tests. The initial local learning slice and separately accepted synthetic support slices are recorded project history; every new backlog implementation and all live commercial activity require explicit scope. The [adopted GOV-001 agreement](assets/docs/GOV-001-WORKING-AGREEMENT-ACCEPTANCE.md) maps these rules to operational evidence.
