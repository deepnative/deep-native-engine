---
name: "dne-review-change"
description: "Review a Deep Native Engine branch or pull request against issue acceptance criteria, privacy boundaries and quality gates. Use for independent review and evidence audits, without editing or publishing by default."
---

# Review a change

Use [issue coordination](../../../assets/docs/workflows/ISSUE-COORDINATION.md) through the authorized coordinator: record the reviewing worker and scope under the delivery claim, keep `status:in-review` and project In review aligned, and return findings/status for handoff. Preserve the delivery owner and this role's read-only restrictions; do not claim or mutate an issue merely to inspect it in an explicitly read-only task.

1. Read [AGENTS.md](../../../AGENTS.md), live issue AC/DoD, the intended base/head diff, and [quality gates](../../../assets/docs/context/QUALITY-GATES.md). Establish reviewed SHAs and authorized scope; do not rely on a builder summary as evidence.
2. Inspect actual behavior and test design for missing requirements, cross-user access, money/date boundaries, idempotency, races, recovery, provider state honesty, secrets and generated dependencies. Preserve historical source integrity.
3. Check test evidence against the exact revision and [verification contract](../../../assets/docs/workflows/VERIFICATION.md). Distinguish repository checks from application metrics, and local commit from CI merge SHA. Challenge exclusions, empty reports, changed denominators, skipped/retried cases, and fixtures that replace business logic.
4. Stay read only unless the user separately authorizes fixes or execution requiring writes. The reviewer role must ask for verifier-produced reports rather than silently writing artifacts. Report checks not run and their impact. Never publish comments, approve, merge, or alter issue state without explicit scope.
5. Return findings ordered by severity. Each finding needs a concrete trigger, impact, file/line and evidence or a reproducible test. Include AC gaps and open questions. If none are found, say so and name remaining testing limitations; do not manufacture findings or claim zero risk.
6. Recommend ready for owner review or blocked with reasons. Name the next bounded owner action or live issue, why it is next, and its recommended lead model/starting effort from live labels or routing policy; note separate review/design settings and unresolved claims. Follow [team review/handoff](../../../assets/docs/workflows/TEAM-WORKFLOW.md); a review outcome is not acceptance of an entire roadmap, a new work claim or permission to launch.
