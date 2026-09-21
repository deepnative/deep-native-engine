# Contributing

Read [AGENTS.md](AGENTS.md), then follow [the team workflow](assets/docs/workflows/TEAM-WORKFLOW.md). Begin with an authorized issue and a small `codex/` branch. Preserve source provenance and other contributors' work.

```sh
make bootstrap
make verify
```

Commit your changes, then run `make verify` again on the intended commit before pushing. The installed pre-push hook also checks the pushed revision and reruns verification. Use the PR template to record evidence and request review. CI is required evidence, not a substitute for local checks. Complete authorized delivery by merging the reviewed PR into `main` after required reviews and checks pass, verify the resulting main CI, and record the merge SHA. The owner has provided standing authorization for this step; do not stop at a draft unless explicitly requested.

See [verification and hook recovery](assets/docs/workflows/VERIFICATION.md) for prerequisites, failures, and the transition to application testing. Repository setup is authorized; application implementation and live commercial activity still require explicit scope.
