# GOV-001: AI-assisted development working agreement acceptance

Decision date: 22 September 2026. Accountable owner: Tom Wu. Live issue: [GOV-001 #11](https://github.com/deepnative/deep-native-engine/issues/11). Claim: `gov-001-working-agreement-acceptance-20260922`.

**Status:** accepted by the accountable owner through the repository instructions supplied for this work. Independent review of this acceptance record and its repository diff is required before merge. This decision adopts the existing delivery controls; it does not authorize a new application slice, deployment, live provider, payment, prospect contact or commercial launch.

## Adopted agreement

Every repository task follows this lifecycle:

1. Read current owner instructions, product direction, context, quality gates and the live issue. Treat archived prompts and local issue snapshots as context rather than authorization.
2. Confirm observable acceptance criteria, dependencies, accountable owner, privacy/provider boundaries, non-goals and test/evidence plan. A backlog item alone is not ready or authorized work.
3. Check live claims, assign the agreed owner, publish a unique worker/task claim and branch, then align one lifecycle label with the GitHub Project status before editing. Re-read for conflicts.
4. Make one bounded change on a `codex/` branch or isolated worktree. Review generated output, dependencies, authorization and failure behavior. Preserve unrelated work and the immutable source archive.
5. Use behavior-first evidence. Application changes reproduce defects or define acceptance behavior before implementation and preserve the unit, PostgreSQL and E2E requirements. Planning work uses source-verifiable documents without invented application or business results.
6. Commit the intended revision, run `make verify`, push through the exact-revision hook, and require independent CI. Never bypass, skip, retry away, reduce or relabel a failed requirement.
7. Obtain independent review of the actual diff and exact-revision evidence. Resolve blocking findings, recheck the current PR head/base, merge under the standing owner authorization and verify the resulting `main` CI.
8. Map every criterion to evidence. Mark full acceptance Done or release/transfer a partial claim while the issue stays open. Keep application, provider, deployment, legal, expert, demand and commercial states separate.

The [root agreement](../../AGENTS.md), [contribution guide](../../CONTRIBUTING.md), [team workflow](workflows/TEAM-WORKFLOW.md), [issue coordination workflow](workflows/ISSUE-COORDINATION.md), [verification contract](workflows/VERIFICATION.md), issue/PR templates, four repository skills and five named roles form one agreement. Labels recommend models and communicate state; they neither select a running model nor grant authorization.

## Acceptance evidence

| GOV-001 acceptance criterion | Repository rule | Operational evidence | Result |
| --- | --- | --- | --- |
| Context-first, issue-first, bounded changes, behavior-first tests, diff review and durable notes | `AGENTS.md`; `CONTRIBUTING.md`; team workflow sections 1, 3, 4 and 6; decision/evidence/handoff templates | [PR #61](https://github.com/deepnative/deep-native-engine/pull/61) records an architecture decision and a bounded gate repair; [PR #64](https://github.com/deepnative/deep-native-engine/pull/64) links behavioral privacy/concurrency evidence | Accepted |
| Definition of ready includes AC, dependencies, owner, boundaries and test plan; backlog is not authorization | Quality-gates definition of ready; delivery issue template; plan/delivery skills | PLAN-001 [#8](https://github.com/deepnative/deep-native-engine/issues/8) resolved the dependency before this claim; GOV-001 was checked for active claims, assigned and moved to In progress before edits | Accepted |
| Definition of done includes intended-revision evidence, all AC, review, prescribed pre-push checks, CI and relevant operations | Quality-gates definition of done; PR template; team workflow sections 4–6; evidence template | Completion records for [#24](https://github.com/deepnative/deep-native-engine/issues/24#issuecomment-5778004072), [#25](https://github.com/deepnative/deep-native-engine/issues/25#issuecomment-5779008512) and planning [#8](https://github.com/deepnative/deep-native-engine/issues/8#issuecomment-5780679747) link the reviewed PR, merge SHA and post-merge `main` CI directly | Accepted |
| Generated code/dependencies receive independent review; current APIs, licenses, lockfiles and secret/privacy boundaries are checked | Root agreement implementation rules; deliver/review skills; PR review checklist; verification dependency audit | `package-lock.json` is committed; CI actions are commit-pinned; `make verify` audits runtime dependencies; no dependency changes are part of GOV-001 | Accepted |
| No automatic agent assignment, bypass, invented live results, unrelated refactors or unauthorized remote actions | Root authorization boundary; model policy; quality gates; all four skills | Deterministic adapters and evidence storage remain explicitly synthetic/local in PRs #62 and #64; model labels have not been treated as assignments | Accepted |
| Claim before work with owner, worker/task ID, scope, branch, lifecycle label and project status; then conflict recheck | Issue coordination workflow; root agreement; contribution guide | [PR #59](https://github.com/deepnative/deep-native-engine/pull/59) exercised claim → review → release; the current claim repeats the process after confirming no In progress/In review work | Accepted |
| Exactly one lifecycle label matches Project status; review, blockers and handoffs are recorded; read-only roles retain restrictions | Issue coordination workflow; plan/review/handoff skills | Issue #11's prior partial claim returned to Backlog; issues #8, #24 and #25 closed with `status:done` and Project Done after main verification | Accepted |
| Full completion reconciles evidence and state; partial work stays open and releases or transfers its claim | Team workflow section 6; issue coordination completion rules; PR template | GOV-001's PR #59 contribution stayed open and released its claim; PLAN-001 #8 closed only after all 13 AC/DoD checks, merge and post-merge CI | Accepted |

## Definition of ready

An issue is ready only when all applicable items below are true:

- The requested outcome is within current owner authorization, and non-goals are explicit.
- Acceptance criteria describe observable results and meaningful failure, recovery, privacy and boundary cases.
- Prerequisite issues and decisions are resolved or are named launch-only blockers that do not affect the bounded slice.
- One actual accountable owner and the required independent reviewer are identified.
- Data classification, authorization, provider and secret boundaries are known.
- The test/evidence plan identifies the authoritative command, records and scenario mapping.
- The live issue has no conflicting claim; labels, assignee and Project status can be synchronized.

Ready does not mean assigned, claimed, implemented, deployed or launched.

## Definition of done

A full issue is done only when all applicable items below are evidenced:

- Every acceptance criterion is linked to an observed artifact, test, trace or accepted decision on the intended revision.
- The complete prescribed local gate passed after the final commit and before push; the pre-push hook repeated it without bypass.
- Required independent review inspected the actual diff/evidence and all blocking findings were resolved.
- PR CI passed for the current head/merge candidate, the PR was merged against the expected head, and resulting `main` CI passed.
- Documentation, decisions, privacy/rollback/operations and follow-up issues reflect the resulting state.
- The live claim is completed, transferred or released; assignee, lifecycle/blocker labels, Project status and issue state agree.
- Remaining provider, deployment, customer, expert, legal and commercial gaps stay explicit.

Partial delivery must use `Refs`, record the remaining criteria and release or transfer its claim. It cannot use Done or close the whole issue.

## Generated output, dependencies and security

- Treat agent-generated code, tests, prose, commands and review comments as untrusted proposals. Review them against requirements, architecture, privacy and failure paths.
- Keep one implementation owner and a distinct independent reviewer for the diff. A reviewer reads the code and evidence rather than accepting the builder's summary.
- Before adding or changing a dependency, use current official documentation, inspect package provenance/license/maintenance, update the committed lockfile and run the security and compatibility checks. Record the decision when the dependency changes architecture, privacy, cost or operations.
- Pin CI actions to commit SHAs, keep credentials out of prompts/source/fixtures/logs and grant workflows/providers only the permissions required by the authorized slice.
- Use private synthetic fixtures and deterministic external-provider boundaries. A green local/CI run proves its stated test scope only.

No dependencies, permissions, provider settings or repository protections change in GOV-001.

## Current official guidance review

The following primary guidance was rechecked on 22 September 2026:

- [GitHub Copilot Agents responsible-use application card](https://docs.github.com/en/copilot/responsible-use/agents): agent output and commands require review, testing and human oversight; code review and secure-development controls still apply.
- [GitHub review of AI-generated code](https://docs.github.com/en/copilot/tutorials/review-ai-generated-code): validate intent, run automated checks and inspect security/quality rather than trusting generated output.
- [Playwright best practices](https://playwright.dev/docs/best-practices): test user-visible behavior, isolate tests, control data, use resilient locators and run tests in CI.
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/): retain the runtime dependency vulnerability audit already included in `make verify`.
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use): keep workflow permissions and third-party action use bounded and reviewable.

These sources support the working method. The repository's 99% unit and journey targets, exact claim process and standing merge workflow remain owner decisions.

## Adoption, maintenance and stop conditions

Tom Wu accepts this working agreement as the default repository process. Later explicit owner instructions may change a bounded task, but they must not be inferred from an issue label, archived prompt or prior implementation. Material changes to authorization, quality thresholds, privacy, merge controls or lifecycle semantics require a reviewable issue, diff, independent review and evidence-backed merge.

Stop the affected work when authorization, ownership, dependencies, privacy boundaries or required evidence cannot be established. Record the blocker and owner; continue only independent authorized work. Do not use a governance document to infer deployment, provider verification, legal clearance, expert capacity, demand, payment or commercial readiness.

After GOV-001 acceptance, the dependency-ready planning issue is [CTP-001 #15](https://github.com/deepnative/deep-native-engine/issues/15). Its existing architecture contribution does not close its remaining audit and acceptance criteria.
