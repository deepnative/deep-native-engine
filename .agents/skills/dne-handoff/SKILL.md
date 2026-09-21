---
name: "dne-handoff"
description: "Verify and hand off a Deep Native Engine task or prepare release evidence. Use for reproducible status, acceptance evidence and next steps; this skill does not itself authorize pushing, merging, deployment or launch."
---

# Verify and hand off

1. Read [AGENTS.md](../../../AGENTS.md), the live issue/PR, [verification contract](../../../assets/docs/workflows/VERIFICATION.md), and current branch/commit/dirty state. Identify the requested stage: planning, tooling, application slice, deployed verification or commercial gate.
2. Run `make verify` for the current checkout without editing implementation, tests, or thresholds. It may create ignored reports. If execution is unavailable or unauthorized, explicitly report it as unverified. Do not label a dirty-tree check as a later commit's evidence.
3. Read the actual report and applicable test logs. Record command, exit status, environment, SHA/tree, numerator/denominator, scenario register and uncovered IDs. Repository-only checks do not measure application unit or E2E coverage. Report first-attempt failures separately from reruns.
4. Map each AC/DoD item to observable evidence. Capture unresolved blockers, dependencies, responsible owner and the next bounded action. Keep simulated/manual/configured/test-verified/live-verified/deployed/commercial states distinct.
5. Produce the [evidence record](../../../assets/docs/templates/EVIDENCE.md) and [handoff](../../../assets/docs/templates/HANDOFF.md). Apply existing task authorization, including the standing merge-to-main instruction in AGENTS.md. For delivery tasks, confirm the PR was merged and verify CI on the resulting main SHA before the final handoff; otherwise complete the team workflow or report the concrete blocker. Honor explicit review-only/draft-only scope and role write restrictions. Re-read live state before authorized updates; deployment still needs its own authorization.
6. A release recommendation additionally needs independent review, rollback/operations evidence and the stage owner's go/no-go. Do not turn green CI or modeled revenue into production, legal, expert, demand or payment proof.
