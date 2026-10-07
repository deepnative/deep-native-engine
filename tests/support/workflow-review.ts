import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
export const WORKFLOW_REVIEW_TEST_SECRET = "invented-workflow-race-secret";
export async function workflowReviewFixture(pool: Pool) {
  const fresh = () => randomBytes(32).toString("hex"),
    member = fresh(),
    admin = fresh(),
    moderator = fresh();
  const members = store(pool),
    auth = authorizationStore(pool),
    feedback = workflowFeedbackStore(pool),
    options = { enabled: true, mode: "test" as const };
  await members.create(member, { background: "professional", goal: "work" });
  const owner = await members.session(member);
  if (owner.kind !== "active") throw Error("Owned race member required");
  const adminId = await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const moderatorId = await auth.provisionStaff(
    moderator,
    "moderator",
    new Date(Date.now() + 3600000),
  );
  const note = "Invented original private concurrency note";
  if ((await feedback.save(member, "WF-001", 1, note, 0)) !== true)
    throw Error("Owned exact source required");
  const reviews = workflowReviewStore(
      pool,
      options,
      WORKFLOW_REVIEW_TEST_SECRET,
    ),
    staff = workflowReviewStaffStore(
      pool,
      options,
      WORKFLOW_REVIEW_TEST_SECRET,
    );
  const preview = await reviews.preview(member, "WF-001");
  if (preview.kind !== "ready") throw Error("Owned exact preview required");
  const request = await reviews.request(member, {
    checked: preview.preview.checked,
    operationId: randomUUID(),
    confirm: "yes",
  });
  if (request.kind !== "applied")
    throw Error("Explicit member request required");
  const checked = await staff.check(
    admin,
    request.receipt.requestId,
    moderatorId,
  );
  if (checked.kind !== "ready") throw Error("Checked moderator required");
  const grant = await staff.assign(admin, checked.checked, randomUUID(), "yes");
  if (grant.kind !== "applied") throw Error("Exact finite grant required");
  return {
    member,
    memberId: owner.learner.id,
    admin,
    adminId,
    moderator,
    moderatorId,
    note,
    members,
    feedback,
    reviews,
    staff,
    requestId: request.receipt.requestId,
    grantId: grant.grant.grantId,
  };
}
