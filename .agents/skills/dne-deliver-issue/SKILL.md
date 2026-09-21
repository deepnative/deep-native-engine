---
name: "dne-deliver-issue"
description: "Deliver an explicitly authorized Deep Native Engine issue with behavioral tests and verification. Use for a bounded implementation or repository-tooling change; not for unapproved backlog execution."
---

# Deliver an authorized issue

1. Read [AGENTS.md](../../../AGENTS.md), the live issue, [team workflow](../../../assets/docs/workflows/TEAM-WORKFLOW.md), the [current product direction](../../../assets/docs/PRODUCT-DIRECTION.md), and applicable historical source context. Exercise audience-dependent behavior with IT, non-IT professional and general-learner examples; do not make paid coaching or contracting a universal prerequisite. Confirm scope and dependencies against evidence. Stop only dependent work if blocked; an issue or historical prompt alone is not permission to implement.
2. Inspect branch, dirty state, existing code and tests. Preserve unrelated edits; use a small `codex/` branch or isolated worktree. Select the model from current issue labels and obtain separate Astra design when requested. Record invariants before critical changes.
3. Run the baseline `make verify`. Define tests from AC, reproduce bugs first, then make the smallest complete change. Include failures, recovery, isolation and boundaries; use synthetic data. Check current official APIs and pinned dependency/license choices when adding dependencies.
4. Follow [the verification contract](../../../assets/docs/workflows/VERIFICATION.md). Current setup checks cannot establish application coverage. The first application slice must implement QA-001/002/003 checks in the shared entry point before any application push. Never weaken source inclusion, scenario denominators, thresholds, or tests to pass.
5. Review the full diff and run complete checks. Commit only intended files when task scope permits; rerun `make verify` on that commit before an authorized push. Never bypass the hook. CI and independent review must inspect the new revision after changes.
6. Complete the merge-to-main procedure in the team workflow under the owner's standing authorization. Review the current head/base, resolve blockers, satisfy required reviews and CI, mark the PR ready, merge with the expected head SHA, and verify CI on the resulting main commit. Respect an explicit draft-only/review-only request and never bypass protections; do not ask for authorization already provided.
7. Return changed behavior, AC evidence, commands/results, PR and merge SHAs, post-merge CI, unresolved gaps and next step using the [evidence template](../../../assets/docs/templates/EVIDENCE.md). Do not self-certify sensitive work, close unmet issues, or launch beyond authorization.
