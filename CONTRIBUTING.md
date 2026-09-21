# Contributing

Read [AGENTS.md](AGENTS.md), then follow [the team workflow](assets/docs/workflows/TEAM-WORKFLOW.md). Begin with an authorized issue and a small `codex/` branch. Preserve source provenance and other contributors' work.

```sh
make bootstrap
make verify
```

Commit your changes, then run `make verify` again on the intended commit before pushing. The installed pre-push hook also checks the pushed revision and reruns verification. Use the PR template to record evidence and request review. CI is required evidence, not a substitute for local checks.

See [verification and hook recovery](assets/docs/workflows/VERIFICATION.md) for prerequisites, failures, and the transition to application testing. Repository setup is authorized; application implementation and live commercial activity still require explicit scope.
