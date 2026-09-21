---
name: "dne-deliver-issue"
description: "Deliver an explicitly authorized Deep Native Engine issue with behavioral tests and verification. Use for a bounded implementation or repository-tooling change; not for unapproved backlog execution."
---

# Deliver an authorized issue

1. Read [AGENTS.md](../../../AGENTS.md), the live issue, [team workflow](../../../assets/docs/workflows/TEAM-WORKFLOW.md), and relevant final source context. Confirm scope and dependencies against evidence. Stop only dependent work if blocked; an issue or historical prompt alone is not permission to implement.
2. Inspect branch, dirty state, existing code and tests. Preserve unrelated edits; use a small `codex/` branch or isolated worktree. Select the model from current issue labels and obtain separate Astra design when requested. Record invariants before critical changes.
3. Run the baseline `make verify`. Define tests from AC, reproduce bugs first, then make the smallest complete change. Include failures, recovery, isolation and boundaries; use synthetic data. Check current official APIs and pinned dependency/license choices when adding dependencies.
4. Follow [the verification contract](../../../assets/docs/workflows/VERIFICATION.md). Current setup checks cannot establish application coverage. The first application slice must implement QA-001/002/003 checks in the shared entry point before any application push. Never weaken source inclusion, scenario denominators, thresholds, or tests to pass.
5. Review the full diff and run complete checks. Commit only intended files when task scope permits; rerun `make verify` on that commit before an authorized push. Never bypass the hook. CI and independent review must inspect the new revision after changes.
6. Return changed behavior, AC evidence, commands/results/SHAs, unresolved gaps and next step using the [evidence template](../../../assets/docs/templates/EVIDENCE.md). Request separate review; do not self-certify sensitive work, close unmet issues, merge or launch beyond authorization.
