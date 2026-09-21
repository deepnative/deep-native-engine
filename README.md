# Deep Native Engine

The Contractor Success Platform roadmap and team workspace. Application implementation has not started. The [GitHub project](https://github.com/orgs/deepnative/projects/1/views/1) and [master roadmap](https://github.com/deepnative/deep-native-engine/issues/1) track delivery.

## Team setup

Install Git, GNU Make, and Python 3.11 or newer (CI uses Python 3.12). No application packages or credentials are needed for local verification.

```sh
git clone git@github.com:deepnative/deep-native-engine.git
cd deep-native-engine
make bootstrap
make verify
```

Until the setup PR is merged, check out `codex/team-agent-workflows` before running these commands. Bootstrap installs the repository's pre-push hook. Verification checks the preserved source, planning references, agent/skill definitions, and tooling behavior. A passed check does **not** claim application unit or E2E coverage. See [verification scope](assets/docs/workflows/VERIFICATION.md).

Read [AGENTS.md](AGENTS.md) and the [team workflow](assets/docs/workflows/TEAM-WORKFLOW.md) before taking an issue. Codex discovers the repo-local skills and custom agents when this repository is opened as a trusted project; reload the project after adding them if needed. Use the same written workflow in other assistants.

| Task | Skill | Suggested role |
| --- | --- | --- |
| Clarify scope and acceptance | `$dne-plan-issue` | `dne-planner` |
| Deliver an authorized slice | `$dne-deliver-issue` | `dne-builder` or `dne-critical-builder` |
| Review changes and evidence | `$dne-review-change` | `dne-reviewer` |
| Validate and hand off work | `$dne-handoff` | `dne-verifier` |

The [documentation index](assets/docs/README.md) includes the original context, model recommendations, templates, and workflow. Shared instructions make the process reproducible; model outputs still require review and tests.
