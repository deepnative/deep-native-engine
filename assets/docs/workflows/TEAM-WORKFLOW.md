# Team delivery workflow

## 1. Establish scope

Read the root [working agreement](../../../AGENTS.md), [current product direction](../PRODUCT-DIRECTION.md), [context index](../context/README.md), [quality gates](../context/QUALITY-GATES.md), and the live issue. Name the actual accountable owner, observable acceptance criteria, dependencies, non-goals, and a test/evidence plan. A Backlog issue or historical build prompt alone does not authorize implementation.

Current scope is planning and repository setup. [GOV-001](https://github.com/deepnative/deep-native-engine/issues/11) tracks the working agreement. QA-001/002/003 remain application testing work. This setup does not close their acceptance criteria.

Use `$dne-plan-issue` for incomplete issues. Resolve blocking decisions; distinguish external launch dependencies from work that can proceed with synthetic fixtures. Retain stable source IDs. Do not silently shrink acceptance scope or promise an unavailable expert/provider.

## 2. Choose a model and role

Current issue labels take precedence over the archived routing table. Labels recommend settings; they do not assign agents or change the running model. If the requested model is unavailable, report it and agree on a substitute before relying on equivalent behavior.

| Role | Model / effort | Responsibility |
| --- | --- | --- |
| `dne-planner` | GPT-6 Astra / high | Architecture, epics, risks, AC and test design; read only |
| `dne-builder` | GPT-5.6 Sol / high | Routine bounded delivery with tests |
| `dne-critical-builder` | GPT-6 Astra / high | Authorization, billing, ledger, concurrency, privacy, core architecture |
| `dne-reviewer` | GPT-6 Astra / high | Independent diff and evidence review; read only |
| `dne-verifier` | GPT-5.6 Sol / high | Reproduce checks and record scoped evidence |

For `design:gpt-6-astra`, obtain Astra's acceptance/test design before Sol implementation. `review:gpt-6-astra` requests independent Astra review. Escalate to xhigh for unresolved invariants or difficult failures with an explicit task setting. See the [complete model policy](../context/MODEL-RECOMMENDATIONS.md).

Example prompts:

```text
$dne-plan-issue Review issue #15 and return a bounded plan with acceptance tests.
$dne-deliver-issue Complete the explicitly authorized scope of issue #11.
$dne-review-change Review this branch against issue #11 and report blockers.
$dne-handoff Prepare verification evidence and a next-step handoff for this PR.
```

Native role definitions live in `.codex/agents/*.toml`; skills live in `.agents/skills/*/SKILL.md`. Skills guide tasks; role files configure custom subagents. A root task's model is selected separately. When delegation is requested, give the named role a bounded task, relevant issue/path, permitted writes, expected evidence, and stop conditions. Do not spawn every role for every task. A separate reviewer must inspect the diff and evidence, not just the builder's summary.

## 3. Deliver a reviewable slice

Create a `codex/` branch or isolated worktree. Run `make bootstrap` once per checkout; it refuses conflicting hook settings. Establish the baseline with `make verify`. Use `$dne-deliver-issue`, read existing code before editing, and define behavioral acceptance tests before implementation. Reproduce bugs, use deterministic synthetic fixtures, and inspect real failure paths. Validate official APIs and locked dependency versions. Record material choices with the [decision template](../templates/DECISION.md).

Application work must first extend the verification entry point under QA-001/002/003. The current scope check rejects application source and manifests outside the setup allowlist. Adding an exception is not implementation of a test gate; reviewers must verify that real application checks replace the setup restriction.

## 4. Verify, push, and review

Use [the verification procedure](VERIFICATION.md). Review the full diff for secrets, unintended changes, source archive mutations, and missing acceptance evidence. Commit, run `make verify` on that commit, then push; the hook reruns checks and rejects a dirty or different revision. CI independently repeats the command on the PR merge candidate. Record local HEAD and CI SHA separately.

Use `$dne-review-change` with the issue, base/head, and reports. Resolve blockers and rerun checks after changes. No `--no-verify`, threshold weakening, retry-only success, or declaring absent tests passed. Configure branch protection only after actual check names have run and the repository owner authorizes that settings change.

## 5. Merge to main and verify

Merging completed, authorized work is part of the owner's standing delivery instruction. After reviewing the latest diff, resolving blocking findings, and satisfying required reviews and checks, mark the PR ready and merge it into `main`. Do not request the same merge authorization again or end the task at a draft PR unless the user explicitly requested that stopping point. Respect repository protections; do not use an admin override.

Immediately before merging, confirm the PR still targets `main` and its head matches the locally tested and reviewed commit. If the head or base changes, refresh the diff and relevant verification before proceeding. Use a merge operation that checks the expected head SHA. Do not merge on stale, missing, failed, cancelled, or skipped required CI results.

Read back the merged state and merge commit SHA from GitHub. Verify CI for that resulting `main` commit, then fetch and fast-forward the local `main` checkout when the working tree is clean. Preserve unrelated work if switching is unsafe. Record the merge SHA, resulting CI evidence, and any synchronization limitation. If post-merge CI fails, investigate and fix it before declaring delivery complete; do not silently treat PR CI as proof of main's result.

## 6. Hand off and close with evidence

Use `$dne-handoff` and the [evidence](../templates/EVIDENCE.md) / [handoff](../templates/HANDOFF.md) templates. Link every acceptance criterion to evidence. Name unresolved work, dependencies, reviewer, revision, commands, results, and the next authorized step. GitHub remains the live status record. Update issue/project state only when authorized and supported by evidence; do not close a whole epic because one child is done.

Model review, CI, deployment, provider verification, expert readiness, legal clearance, customer demand, and commercial launch are separate outcomes. A live launch requires its own recorded go/no-go decision.

## Configuration references

- [OpenAI repository skills](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI custom subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI repository instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

These paths and formats were checked when this setup was prepared. Recheck official documentation when upgrading the assistant; do not copy guessed configuration keys.
