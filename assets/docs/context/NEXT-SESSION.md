# Handoff

The current direction is the [Deep Native Engine AI learning and participation ecosystem](../PRODUCT-DIRECTION.md), serving IT practitioners, other professionals and general learners. Contractor-only positioning is superseded. Shared learning, practical application, bounded participation and reviewed contributions are core; career/contractor services and coaching offers are optional. [ECO-01 through ECO-08](ECOSYSTEM-JOURNEYS.md) extend the QA-002 acceptance register.

Current authorization includes the [initial local learning slice](../INITIAL-LEARNING-SLICE.md) explicitly confirmed by the owner under #1. The owner also accepted the [file-first hosted modular-monolith architecture](../decisions/ADR-0002-file-first-hosted-modular-monolith.md): Git-versioned Markdown/YAML for authored public content and PostgreSQL for private, mutable and transactional state. Content migration, hosted implementation, provisioning, deployment, live integrations and broader backlog execution require their own scope.

- [Project backlog](https://github.com/orgs/deepnative/projects/1/views/1)
- [Master roadmap](https://github.com/deepnative/deep-native-engine/issues/1)
- [GOV-001 working agreement](https://github.com/deepnative/deep-native-engine/issues/11)
- [Team workflow](../workflows/TEAM-WORKFLOW.md)
- [Issue coordination](../workflows/ISSUE-COORDINATION.md): claim authorized work before starting; keep labels, owner and project Status current.
- [Verification procedure](../workflows/VERIFICATION.md)

Open this repository as the working directory. Read root `AGENTS.md`, [the context index](README.md), [quality gates](QUALITY-GATES.md), and the assigned live issue. The prior source folder is archived under `source-2026-09-15/`; final outputs take precedence over older drafts. All 25 manifest-listed files retain their original hashes. A personal runtime dependency symlink is deliberately excluded.

Run `make setup` once per checkout and `make verify` before every push. The repository includes four skills, five named Codex roles, contribution/issue/PR guidance, an exact-revision pre-push hook, and Linux/macOS CI checks. Verification covers repository assets and the initial application slice: unit coverage, PostgreSQL integration, desktop/mobile Chromium journeys, build and dependency audit. The 27 full-MVP requirements remain outstanding. Reports go to ignored `artifacts/`. The owner has also authorized merge to `main` as part of delivery: complete PR review and required CI, merge the checked head, verify the resulting main CI, and synchronize the local checkout. Do not stop at a draft or ask again for an already-authorized merge.

All 25 CTP specifications are preserved within the original 55-issue roadmap, six phase epics and eight milestones. Local issue bodies/JSON and project/model verification records are dated publication snapshots, not a live status mirror. Check GitHub before taking work. Setup contributes to GOV-001; it does not complete its owner/review/dependency requirements or the application QA issues.

Next execution decisions include the file-backed content implementation slice, production identity/hosting, foundation access, curriculum and qualified review readiness. QA-001 (#16), QA-002 (#17) and QA-003 (#22) now contribute initial-slice checks through the shared entry point; preserve full-release criteria and do not close partial issues. Check live GitHub evidence before taking a new claim.

The agreed gates remain >=99% for each unit metric, >=99% documented E2E journey coverage, 100% critical journeys and required test passes. Preserve the versioned denominator including unimplemented scenarios. Missing/skipped/failed/retry-only scenarios do not count. CI, provider verification, deployment, and commercial readiness require separate evidence.
