# Issue ownership and work status

Before starting or resuming authorized issue work, publish who is working on it and what they have claimed. This includes planning, documentation, implementation, verification and review. Use the same procedure for people and agents; a model recommendation is not a work claim. GitHub's live labels, assignees and latest claim/handoff note take precedence over status text in a saved planning snapshot.

## Labels and project status

Keep exactly one lifecycle label on an issue. Change it together with the **Status** field in [Project 1](https://github.com/orgs/deepnative/projects/1/views/1), preserving model, type, priority and phase labels, milestones and other project fields.

| Issue label | Project Status | Meaning |
| --- | --- | --- |
| `status:backlog` | Backlog | Planned or paused; no active worker claim |
| `status:ready` | Ready | Dependencies and scope are ready to claim within existing authorization |
| `status:in-progress` | In progress | A named worker owns an active, bounded claim |
| `status:in-review` | In review | Claimed work awaits review, required checks or delivery verification |
| `status:done` | Done | Owner-accepted, CI-verified delivery scope; unmet broader AC are linked to open follow-up issues |

`blocked` is an additional flag, not a lifecycle label. Keep the lifecycle state and owner while awaiting a dependency; record the blocker, who can resolve it and the next action. Remove `blocked` when resolved. If work is released instead, use Backlog or Ready and explicitly record that the claim ended. A blocked or old claim is not permission to take over.

These are workflow conventions, not an installed label-to-project automation or an atomic lock. The owner/coordinator updates both surfaces and reads them back. If either update fails, record the mismatch and finish synchronization before dependent work continues. Fetch current project item/field/option IDs rather than assuming IDs from another board.

## Claim before work

1. Read the live issue, assignees, lifecycle/blocker labels, recent claim/handoff comments, linked PRs and project status. Verify authorization and the specific scope to be claimed. An existing assignee or active claim requires coordination with its owner; do not silently replace it or start overlapping work.
2. Identify one accountable GitHub assignee and the actual worker. For agents using a shared GitHub account, also record a unique task/claim ID and branch or worktree. Two agents using the same account are different workers.
3. Assign the agreed owner, replace the previous lifecycle label with `status:in-progress`, and set the project to In progress. Publish a claim note using the fields below. Use a `codex/` branch or isolated worktree for edits.
4. Re-read the issue, recent comments and project immediately afterward. Confirm the assignee, claim ID, one lifecycle label and matching status; check for a competing claim. Labels and assignments alone cannot prevent simultaneous starts. If a conflict appears, pause overlapping work and resolve it with the owner/coordinator before editing.

Claim note:

```text
Claim ID / worker or task:
Accountable GitHub owner:
Started at (with timezone):
Authorized scope and issue AC subset:
Branch/worktree or existing PR:
Next checkpoint:
```

For a read-only planner, reviewer or verifier, the authorized coordinator publishes the claim/status and records that worker's role and bounded scope. The read-only worker returns status/handoff information to the coordinator without changing GitHub or its own permissions. An explicitly read-only user request remains read only. Independent review of an existing claim is coordinated under that claim; it does not replace the delivery owner.

For concurrent work on one larger issue, the owner agrees on non-overlapping scopes and records each worker/branch. Use bounded child issues when separate ownership is needed, and check shared files/dependencies before work. Claiming a parent does not automatically claim every child; starting a child does not mark an entire epic complete. This procedure does not itself authorize spawning agents or starting application work.

## Keep the claim current

- At a meaningful checkpoint, link the PR/evidence and state remaining work. Move to `status:in-review` / In review when handing off for review or delivery checks; requested changes move it back to In progress.
- Before resuming a paused task, re-read the current claim and remote state. Never overwrite another worker's edits or infer an expired reservation merely from elapsed time.
- For a blocker, add `blocked` and publish its cause, responsible owner and next action. Do not leave teammates guessing whether work is active, waiting or abandoned.
- For a handoff, name the incoming worker, transfer ownership with their agreement, and preserve the branch/PR, tested revision, findings and next step. Clear only your own claim; do not remove another worker's assignment or unrelated labels.

## Finish or release

The owner directed on 23 September 2026 that changes passing CI be merged and their delivery issues moved to Done. After the exact-commit gate, recorded review, required PR checks, guarded merge and successful CI on the resulting `main` commit, record the PR, merge SHA and CI. Set `status:done` / Done, clear any blocker transferred to follow-up work, and close the delivery issue. CI proves the checked change, not every original product promise.

If the issue described more than the delivered slice, first create linked open follow-up issues for every unmet acceptance area, with the original requirements, dependency/owner decision and stop conditions. In the original closeout, state the accepted slice, evidence, unresolved scope and follow-up links. Use `Refs` rather than an automatic closing keyword for a partial-scope PR so closure happens only after main verification and carryover. Keep the epic and release gates open. Never infer qualified approval, legal clearance, service capacity, payment success or full-MVP coverage from CI. A task that pauses without merged, verified delivery instead records its remaining work, releases or transfers the claim, and returns the open issue to Ready or Backlog.

Check labels, assignees, issue open/closed state and project status again before the final handoff. If GitHub is unavailable or a claim cannot be coordinated, report the unsynchronized state and hold overlapping work; unrelated authorized work can continue.
