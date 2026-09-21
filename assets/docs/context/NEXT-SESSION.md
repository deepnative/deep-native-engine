# Handoff

The current direction is the [Deep Native Engine AI learning and participation ecosystem](../PRODUCT-DIRECTION.md), serving IT practitioners, other professionals and general learners. Contractor-only positioning is superseded. Shared learning, practical application, bounded participation and reviewed contributions are core; career/contractor services and coaching offers are optional. [ECO-01 through ECO-08](ECOSYSTEM-JOURNEYS.md) extend the QA-002 acceptance register.

Current authorization: context migration, planning, and repository agent/skill/workflow setup. Application implementation, deployment, and live integrations remain on hold until explicitly requested. Historical start-coding instructions do not change that scope.

- [Project backlog](https://github.com/orgs/deepnative/projects/1/views/1)
- [Master roadmap](https://github.com/deepnative/deep-native-engine/issues/1)
- [GOV-001 working agreement](https://github.com/deepnative/deep-native-engine/issues/11)
- [Team workflow](../workflows/TEAM-WORKFLOW.md)
- [Verification procedure](../workflows/VERIFICATION.md)

Open this repository as the working directory. Read root `AGENTS.md`, [the context index](README.md), [quality gates](QUALITY-GATES.md), and the assigned live issue. The prior source folder is archived under `source-2026-09-15/`; final outputs take precedence over older drafts. All 25 manifest-listed files retain their original hashes. A personal runtime dependency symlink is deliberately excluded.

Run `make bootstrap` once per checkout and `make verify` before every push. The repository includes four skills, five named Codex roles, contribution/issue/PR guidance, an exact-revision pre-push hook, and Linux/macOS CI checks. Current verification covers repository tooling and planning assets; application unit/E2E coverage remains unimplemented. Reports go to ignored `artifacts/`. The owner has also authorized merge to `main` as part of delivery: complete PR review and required CI, merge the checked head, verify the resulting main CI, and synchronize the local checkout. Do not stop at a draft or ask again for an already-authorized merge.

All 25 CTP specifications are preserved within the original 55-issue roadmap, six phase epics and eight milestones. Local issue bodies/JSON and project/model verification records are dated publication snapshots, not a live status mirror. Check GitHub before taking work. Setup contributes to GOV-001; it does not complete its owner/review/dependency requirements or the application QA issues.

Next execution decisions include PLAN-001 (#8), GOV-001 (#11), and architecture CTP-001 (#15). Before the first authorized application push, implement QA-001 (#16), QA-002 (#17), and QA-003 (#22) through the shared verification entry point and replace the setup-only scope restriction with real application checks. No untested application bootstrap push is permitted.

The agreed gates remain >=99% for each unit metric, >=99% documented E2E journey coverage, 100% critical journeys and required test passes. Preserve the versioned denominator including unimplemented scenarios. Missing/skipped/failed/retry-only scenarios do not count. CI, provider verification, deployment, and commercial readiness require separate evidence.
