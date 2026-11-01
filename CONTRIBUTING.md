# Contributing

Read [AGENTS.md](AGENTS.md), then follow [the team workflow](assets/docs/workflows/TEAM-WORKFLOW.md). Begin with an authorized issue and a small `codex/` branch. Preserve source provenance and other contributors' work.

Claim the issue before editing: check existing ownership, assign the agreed owner, apply `status:in-progress`, set project In progress and record your task/branch and scope. Re-read to detect competing claims. Follow [issue coordination](assets/docs/workflows/ISSUE-COORDINATION.md) for review, blockers, handoff and release; update the live status when the task ends.

```sh
make setup
```

Use the [commit/push/merge testing strategy](assets/docs/workflows/LOCAL-VERIFICATION-PLAYBOOK.md#commit-push-and-merge-testing-strategy): establish a focused behavioral baseline, run affected checks while editing, and finish documentation and source review before committing. Run the complete `make verify` on the final clean commit intended for push. The installed pre-push hook reuses its intact exact-revision/runtime/artifact receipt; missing or changed proof runs the full gate. Keep focused output separate from acceptance evidence. Review and handoff inspect original proof rather than automatically rerunning. All tests run locally; GitHub Actions only deploys to Azure, with no PR/main test or proof-promotion job. Use the PR template to record evidence and review. Recheck head/base and actual protections; integrate and verify any changed combined source before merging. Merge with the expected head SHA, read back the resulting main tree/parents against the tested source, and record the merge SHA. The owner has provided standing authorization for this step; do not stop at a draft unless explicitly requested.

See [verification and hook recovery](assets/docs/workflows/VERIFICATION.md) for prerequisites, failures and application tests. The initial local learning slice and separately accepted synthetic support slices are recorded project history; every new backlog implementation and all live commercial activity require explicit scope. The [adopted GOV-001 agreement](assets/docs/GOV-001-WORKING-AGREEMENT-ACCEPTANCE.md) maps these rules to operational evidence.
