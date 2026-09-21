# Deep Native Engine

An AI learning and participation ecosystem for IT practitioners, professionals in other fields, and anyone who wants to learn, apply AI and contribute with others. See [the product direction](assets/docs/PRODUCT-DIRECTION.md) for audiences, shared learning paths and optional coaching services. The first local learning slice is implemented; the full roadmap remains in progress. The [GitHub project](https://github.com/orgs/deepnative/projects/1/views/1) and [master roadmap](https://github.com/deepnative/deep-native-engine/issues/1) track delivery.

## Run the local learning preview

Choose a goal, practise a beginner-friendly AI instruction, save a draft and complete a self-assessed exercise. Examples support curious learners, non-IT professionals and IT practitioners. Work persists in local PostgreSQL and is private to its browser session; use invented data only.

Prerequisites: Node 24 (`.nvmrc`), Git, Make, Python 3.11+, Docker/Compose with a running daemon.

```sh
make setup
make verify
make dev
```

Open `http://127.0.0.1:3000`. Setup installs locked dependencies, Chromium, the local database and the pre-push hook. It preserves an existing `.env`. See [verification and troubleshooting](assets/docs/workflows/VERIFICATION.md).

The shared gate enforces >=99% unit statements, branches, functions and lines, >=99% documented slice journeys, and 100% critical journeys and required test passes. It runs real PostgreSQL integration and desktop/mobile Chromium tests. [Scope and acceptance](assets/docs/INITIAL-LEARNING-SLICE.md) explain the remaining full-MVP work. Production accounts, qualified review, community, live AI and payments are not yet available.

## Team setup

Read [AGENTS.md](AGENTS.md) and the [team workflow](assets/docs/workflows/TEAM-WORKFLOW.md) before taking an issue. Codex discovers the repo-local skills and custom agents when this repository is opened as a trusted project; reload the project after adding them if needed. Use the same written workflow in other assistants.

| Task | Skill | Suggested role |
| --- | --- | --- |
| Clarify scope and acceptance | `$dne-plan-issue` | `dne-planner` |
| Deliver an authorized slice | `$dne-deliver-issue` | `dne-builder` or `dne-critical-builder` |
| Review changes and evidence | `$dne-review-change` | `dne-reviewer` |
| Validate and hand off work | `$dne-handoff` | `dne-verifier` |

The [documentation index](assets/docs/README.md) includes the original context, model recommendations, templates, and workflow. Shared instructions make the process reproducible; model outputs still require review and tests. Delivery includes merging accepted changes to `main` and verifying the resulting CI.
