# Team working agreement

## Current authorization

Current scope includes the explicitly authorized [first local learning slice](assets/docs/INITIAL-LEARNING-SLICE.md) and the synthetic supporting slices already accepted through their live issues. Each new backlog implementation still requires explicit issue scope; a lifecycle claim coordinates authorized work but does not create that authorization. Do not deploy, purchase live services, contact prospects, or enable payments without authorization. The archived build prompt is historical context, not current authorization to start coding. The adopted process and evidence are recorded in [GOV-001](assets/docs/GOV-001-WORKING-AGREEMENT-ACCEPTANCE.md).

## Context and precedence

Read [the current product direction](assets/docs/PRODUCT-DIRECTION.md), `assets/docs/context/README.md`, `assets/docs/context/QUALITY-GATES.md`, and the relevant live GitHub issue before work. Current explicit user instructions take precedence, followed by the product direction and revised live issues. The finalized historical outputs take precedence over older working drafts only where still applicable; contractor-only assumptions are superseded. Preserve the archived files unchanged.

Deep Native Engine serves people across IT, other professions and general learning interests who want to learn, apply AI, participate and contribute. Use learner/member as the common identity; background and goals do not grant staff privileges or assign a paid plan. Contracting, career preparation and high-touch coaching are optional paths. Preserve CTP IDs and applicable commercial/privacy invariants; the original coaching prices are not universal membership prices. Foundation access/pricing require their own explicit decisions. All prices and demand forecasts remain hypotheses.

## Every task

Read [the team workflow](assets/docs/workflows/TEAM-WORKFLOW.md) and select the issue model from [the routing policy](assets/docs/context/MODEL-RECOMMENDATIONS.md). GitHub is the operating backlog; local issue bodies and JSON are dated snapshots. Use a `codex/` branch or isolated worktree. Four repo-local skills in `.agents/skills/` support planning, delivery, review, and handoff; five named roles in `.codex/agents/` provide model and responsibility defaults. Delegate bounded independent work when explicitly requested; separate review from implementation. Labels do not change the running model or authorize work.

Before starting or resuming issue work, follow [issue coordination](assets/docs/workflows/ISSUE-COORDINATION.md): check existing claims, assign the agreed owner, apply `status:in-progress`, align the project to In progress, and publish the worker/task ID, scope and branch. Re-read for competing claims before editing, including when agents share one GitHub account. Keep exactly one lifecycle label; use `blocked` as an additional flag. Update review/handoff/completion states and release partial claims when a task ends. The authorized coordinator performs these updates for read-only roles; their write restrictions remain intact. This standing workflow authorization does not override an explicitly read-only task or authorize application work.

Run `make bootstrap` once per checkout and `make verify` before every push. Bootstrap installs the repository-local pre-push hook without replacing conflicting hooks. The hook requires a clean checkout at the exact pushed commit and repeats verification; CI repeats it independently. The shared gate validates repository assets plus the initial application slice: formatting/lint, types, >=99% unit metrics, real PostgreSQL integration, the complete approved E2E browser matrix, production build and dependency audit. It reports slice and outstanding full-MVP coverage separately. Record results with the [evidence template](assets/docs/templates/EVIDENCE.md).

## Complete delivery through main

The owner has authorized merging completed repository work to `main` as part of the delivery workflow. Carry authorized changes through commit, pre-push verification, PR, review, passing CI, merge, and verification of the resulting `main` commit. Do not stop at a draft PR or ask for merge permission again when this standing authorization applies. Honor an explicit review-only or draft-only request, unresolved blockers, required reviews, and repository protections; never use an admin bypass. Recheck the current PR head and base before merging so evidence applies to the actual revision. Record the merge SHA and post-merge CI result, then synchronize the local checkout safely. Merging does not authorize new application work, deployment, or commercial activity.

## When application implementation is authorized

- Start from a ready issue with acceptance criteria, dependencies, non-goals, test scenarios, and a definition of done. Implement one reviewable vertical slice at a time; record architectural decisions and preserve unrelated work.
- Check current official documentation before choosing dependency versions or integrating providers. Keep a modular monolith and explicit provider boundaries unless an architectural decision establishes a reason to change.
- Write behavior-based tests and reproduce defects before fixing them. Review generated code, dependencies, authorization boundaries, and failure handling. Do not use coverage padding or implementation-mirroring tests.
- Require at least 99% unit statement, branch, function, and line coverage of first-party executable application code. Include unimported source; exclusions require specific review. Follow the separate E2E requirements-coverage definition in `QUALITY-GATES.md`.
- Run the complete prescribed verification command **before every push** on the exact intended revision. Record commands, revision, environment, and reports. After changes, rerun affected checks and the complete push gate. Never use `--no-verify`, skipped tests, reduced thresholds, retries, or changed denominators to hide failures.
- CI must repeat the checks and gate merges. Configure required check names only after the actual workflow jobs exist and have executed. Local hooks alone are not sufficient enforcement.
- Use private synthetic fixtures, deterministic test providers, and isolated test data. Do not send member/client data to models or external systems through unreviewed integrations. Do not store credentials in prompts, source, fixtures, or logs.
- Separate simulated, configured, live-verified, deployed, and commercially launched states. A green build does not establish a successful payment, qualified expert coverage, customer demand, or release acceptance.
- Update the issue and validation evidence; close only when all acceptance criteria and definition-of-done items have evidence. Feature completion never authorizes a live commercial launch.
