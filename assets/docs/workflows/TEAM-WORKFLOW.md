# Team delivery workflow

## 1. Establish scope

Read the root [working agreement](../../../AGENTS.md), [current product direction](../PRODUCT-DIRECTION.md), [context index](../context/README.md), [quality gates](../context/QUALITY-GATES.md), and the live issue. Name the actual accountable owner, observable acceptance criteria, dependencies, non-goals, and a test/evidence plan. A Backlog issue or historical build prompt alone does not authorize implementation.

Current scope includes the owner-approved [initial local learning slice](../INITIAL-LEARNING-SLICE.md) and separately accepted synthetic support slices. [GOV-001](../GOV-001-WORKING-AGREEMENT-ACCEPTANCE.md) records the adopted working agreement and operational evidence. Each new backlog implementation still needs explicit issue scope. QA-001/002/003 now have initial-slice checks; their broader release criteria remain open.

Use `$dne-plan-issue` for incomplete issues. Resolve blocking decisions; distinguish external launch dependencies from work that can proceed with synthetic fixtures. Retain stable source IDs. Do not silently shrink acceptance scope or promise an unavailable expert/provider.

Before work, follow [issue coordination](ISSUE-COORDINATION.md). Check existing ownership, claim the bounded scope with an assignee and worker/task ID, set `status:in-progress` and project In progress, then re-read for conflicts. This applies to planning and documentation too. Authorized coordinators handle GitHub updates for read-only workers. Keep the claim current through review, blockers, handoff and completion; release it explicitly when only a subset is delivered.

## 2. Choose a model and role

Current issue labels take precedence over the archived routing table. Labels recommend settings; they do not assign agents or change the running model. If the requested model is unavailable, report it and agree on a substitute before relying on equivalent behavior.

| Role | Model / effort | Responsibility |
| --- | --- | --- |
| `dne-planner` | GPT-6 Astra / high | Architecture, epics, risks, AC and test design; read only |
| `dne-builder` | GPT-6 Sol / high | Routine bounded delivery with tests |
| `dne-critical-builder` | GPT-6 Astra / high | Authorization, billing, ledger, concurrency, privacy, core architecture |
| `dne-reviewer` | GPT-6 Astra / high | Independent diff and evidence review; read only |
| `dne-verifier` | GPT-6 Sol / high | Reproduce checks and record scoped evidence |

Role files provide defaults; the live issue's model and reasoning labels give the per-issue recommendation. For `design:gpt-6-astra`, obtain Astra's acceptance/test design before Sol implementation. `review:gpt-6-astra` recommends independent Astra review when a separate review is requested or required; the label alone does not hold a green PR. Start XHigh when `reasoning:xhigh` is present; for High issues, `escalate:xhigh` recommends changing the task setting if difficult invariants or failures arise. See the [complete model policy](../context/MODEL-RECOMMENDATIONS.md).

Use the same live labels when recommending a **next** issue at handoff. State its lead model and starting effort, and distinguish any design/review model and effort. If labels are absent or conflict, use the routing rules and flag the proposed label correction; do not imply the current task has switched models.

Example prompts:

```text
$dne-plan-issue Review issue #15 and return a bounded plan with acceptance tests.
$dne-deliver-issue Complete the explicitly authorized scope of issue #11.
$dne-review-change Review this branch against issue #11 and report blockers.
$dne-handoff Prepare verification evidence and a next-step handoff for this PR.
```

Native role definitions live in `.codex/agents/*.toml`; skills live in `.agents/skills/*/SKILL.md`. Skills guide tasks; role files configure custom subagents. A root task's model is selected separately. When delegation is requested, give the named role a bounded task, relevant issue/path, permitted writes, expected evidence, and stop conditions. Do not spawn every role for every task. When separate review is required, that reviewer must inspect the diff and evidence, not just the builder's summary.

## 3. Deliver a reviewable slice

Create a `codex/` branch or isolated worktree. Run `make bootstrap` once per checkout; it refuses conflicting hook settings. Establish the baseline with `make verify`. Use `$dne-deliver-issue`, read existing code before editing, and define behavioral acceptance tests before implementation. Reproduce bugs, use deterministic synthetic fixtures, and inspect real failure paths. Validate official APIs and locked dependency versions. Record material choices with the [decision template](../templates/DECISION.md).

Application work uses the shared repository/application gate under QA-001/002/003. New source types need measured coverage and a reviewed scope extension. Reviewers must inspect real behavioral checks and preserve the approved journey inventory.

## 4. Verify, push, and review

Use [the verification procedure](VERIFICATION.md). Review the full diff for secrets, unintended changes, source archive mutations, and missing acceptance evidence. Commit, run `make verify` on that commit, then push; the hook reruns checks and rejects a dirty or different revision. CI independently repeats the command on the PR merge candidate. Record local HEAD and CI SHA separately.

The PR author reviews the current diff against the issue's acceptance criteria, privacy/security boundaries and actual reports, then records findings and limitations as a self-review. Use `$dne-review-change` with the issue, base/head and reports when a separate review is explicitly requested or required; do not describe self-review as independent. Resolve blockers and rerun checks after changes. No `--no-verify`, threshold weakening, retry-only success, or declaring absent tests passed. Configure branch protection only after actual check names have run and the repository owner authorizes that settings change.

Link the PR in the active claim and move the issue to `status:in-review` / In review when handing off for review or delivery checks. Requested changes return it to In progress. Preserve the delivery owner while recording the reviewing worker.

## 5. Merge to main and verify

Merging completed, authorized work is part of the owner's standing delivery instruction. Once the latest diff has a recorded self-review, blocking findings are resolved, the exact-commit local gate and current PR CI pass, and actual required reviews/protections are satisfied, mark the PR ready and merge it into `main` promptly. Do not leave a green PR open only for an optional reviewer, including one recommended by a model label; do not request the same merge authorization again or end at a draft PR unless the user explicitly requested that stopping point. Respect repository protections; do not use an admin override. If a check is missing, failed or stale, a finding is unresolved, or a required review or owner decision is pending, record the blocker and responsible owner and keep the PR open.

Immediately before merging, confirm the PR still targets `main` and its head matches the locally tested and reviewed commit. If the head or base changes, refresh the diff and relevant verification before proceeding. Use a merge operation that checks the expected head SHA. Do not merge on stale, missing, failed, cancelled, or skipped required CI results.

Read back the merged state and merge commit SHA from GitHub. Verify CI for that resulting `main` commit, then fetch and fast-forward the local `main` checkout when the working tree is clean. Preserve unrelated work if switching is unsafe. Record the merge SHA, resulting CI evidence, and any synchronization limitation. If post-merge CI fails, investigate and fix it before declaring delivery complete; do not silently treat PR CI as proof of main's result.

After successful main CI, clean up **that PR's** delivery branch by default. Confirm the PR is merged, its recorded head SHA is the remote branch tip, no open PR or continuing work claim still uses the branch, and the local branch has no unpushed commits. If it has an isolated worktree, confirm the entire worktree is clean before removing it. Delete the remote branch, remove the clean worktree if any, and delete the local branch; a verified squash merge may require force-deleting its local branch after these checks. Never delete `main`, another worker's branch, a dirty worktree or a branch whose ownership/tip has changed. If any check fails, keep the branch and record the concrete blocker and cleanup owner in the handoff. Confirm the remote and local refs are absent and the synchronized `main` checkout is clean.

## 6. Hand off and close with evidence

Use `$dne-handoff` and the [evidence](../templates/EVIDENCE.md) / [handoff](../templates/HANDOFF.md) templates. Link every acceptance criterion to evidence. Name unresolved work, dependencies, self-review and any required separate reviewer, revision, commands, results, and the next authorized step. GitHub remains the live status record. Update issue/project state only when authorized and supported by evidence; do not close a whole epic because one child is done.

Reconcile labels, assignees and project Status using the coordination workflow. Under the owner's 23 September 2026 direction, a scoped delivery whose PR and resulting `main` commit pass their required checks becomes `status:done` / Done and closes. If a broad issue has unmet acceptance areas, create linked follow-up issues before closing it; record the accepted slice, exact CI evidence, and remaining work in the original closeout. A pause without merged, verified delivery still releases or transfers the claim and leaves the issue Ready or Backlog. Closing a delivery slice does not close its epic or establish release readiness.

Every completed, partial, blocked or paused handoff names **one next bounded action** with a live issue link and why it is the next priority, or a specific owner decision when no issue is ready. Check dependencies and active claims before recommending it; state any blocker and owner. Include the recommended lead model and starting reasoning effort from current labels/policy, plus separate design/review settings when relevant. This is a plan for the next handoff, not a claim, model switch or authorization to execute that issue.

Model review, CI, deployment, provider verification, expert readiness, legal clearance, customer demand, and commercial launch are separate outcomes. A live launch requires its own recorded go/no-go decision.

## Configuration references

- [OpenAI repository skills](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI custom subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI repository instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

These paths and formats were checked when this setup was prepared. Recheck official documentation when upgrading the assistant; do not copy guessed configuration keys.
