import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  db = store(pool),
  secret = "invented-workflow-export-secret",
  options = { enabled: true, mode: "test" as const };
const reviews = workflowReviewStore(pool, options, secret),
  staff = workflowReviewStaffStore(pool, options, secret),
  exports = memberExportStore(pool);
const fresh = () => randomBytes(32).toString("hex");
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
async function actors() {
  const member = fresh(),
    admin = fresh(),
    moderator = fresh();
  await db.create(member, { background: "professional", goal: "work" });
  const identity = await db.session(member);
  if (identity.kind !== "active") throw Error("Owned member required");
  const auth = authorizationStore(pool);
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
  expect(
    await workflowFeedbackStore(pool).save(
      member,
      "WF-001",
      1,
      "Invented export source note",
      0,
    ),
  ).toBe(true);
  return {
    member,
    memberId: identity.learner.id,
    admin,
    adminId,
    moderator,
    moderatorId,
  };
}
async function assigned(f: Awaited<ReturnType<typeof actors>>) {
  const preview = await reviews.preview(f.member, "WF-001");
  if (preview.kind !== "ready") throw Error("Owned preview required");
  const operationId = randomUUID();
  const request = await reviews.request(f.member, {
    checked: preview.preview.checked,
    operationId,
    confirm: "yes",
  });
  if (request.kind !== "applied") throw Error("Member request required");
  const checked = await staff.check(
    f.admin,
    request.receipt.requestId,
    f.moderatorId,
  );
  if (checked.kind !== "ready") throw Error("Checked moderator required");
  const assignKey = randomUUID(),
    grant = await staff.assign(f.admin, checked.checked, assignKey, "yes");
  if (grant.kind !== "applied") throw Error("Exact assignment required");
  return {
    requestId: request.receipt.requestId,
    grantId: grant.grant.grantId,
    operationId,
    assignKey,
  };
}
it("WFREV-07 export paginates owned request/assignment metadata without staff identities, keys or copied note text", async () => {
  const own = await actors(),
    foreign = await actors();
  const original = await assigned(own);
  expect(
    await reviews.withdraw(own.member, original.requestId, randomUUID(), "yes"),
  ).toMatchObject({ kind: "applied" });
  const historical = Array.from({ length: 50 }, () => ({
    requestId: randomUUID(),
    grantId: randomUUID(),
  }));
  // Populate withdrawn historical metadata in bulk for the export boundary.
  // Request, assignment and withdrawal above still use the actual stores;
  // these additional fixtures do not represent effective reading permission.
  await pool.query(
    `INSERT INTO workflow_review_requests(id,workspace_id,member_id,source_instance_id,workflow_id,workflow_version,source_revision,expires_at,created_at,withdrawn_at)
     SELECT fixture.id,r.workspace_id,r.member_id,r.source_instance_id,r.workflow_id,r.workflow_version,r.source_revision,r.expires_at,r.created_at,r.withdrawn_at
     FROM workflow_review_requests r CROSS JOIN unnest($2::uuid[]) fixture(id) WHERE r.id=$1`,
    [original.requestId, historical.map((row) => row.requestId)],
  );
  await pool.query(
    `INSERT INTO workflow_review_grants(id,request_id,workspace_id,moderator_id,administrator_id,source_instance_id,source_revision,starts_at,expires_at,created_at,revoked_at)
     SELECT fixture.grant_id,fixture.request_id,g.workspace_id,g.moderator_id,g.administrator_id,g.source_instance_id,g.source_revision,g.starts_at,g.expires_at,g.created_at,g.revoked_at
     FROM workflow_review_grants g CROSS JOIN unnest($2::uuid[],$3::uuid[]) fixture(request_id,grant_id) WHERE g.id=$1`,
    [
      original.grantId,
      historical.map((row) => row.requestId),
      historical.map((row) => row.grantId),
    ],
  );
  const ids = [original, ...historical];
  expect(await staff.read(own.moderator, historical[0]!.grantId)).toEqual({
    kind: "denied",
  });
  const excluded = await assigned(foreign);
  const records: Record<string, Record<string, unknown>[]> = {};
  let cursor: string | undefined,
    pageCount = 0;
  do {
    const result = await exports.exportOwned(own.member, cursor);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw Error("Owned export page required");
    for (const [name, rows] of Object.entries(result.payload.records))
      records[name] = [...(records[name] ?? []), ...rows];
    pageCount++;
    expect(pageCount).toBeLessThan(10);
    if (result.payload.page.nextCursor) {
      expect(
        await exports.exportOwned(
          foreign.member,
          result.payload.page.nextCursor,
        ),
      ).toEqual({ kind: "denied" });
      expect(
        await exports.exportOwned(
          own.member,
          result.payload.page.nextCursor + "!",
        ),
      ).toEqual({ kind: "denied" });
    }
    cursor = result.payload.page.nextCursor ?? undefined;
  } while (cursor);
  expect(pageCount).toBeGreaterThan(1);
  expect(records.workflowReviewRequests).toHaveLength(51);
  expect(records.workflowReviewAssignments).toHaveLength(51);
  expect(records.workflowReviewRequests!.every((row) => row.withdrawnAt)).toBe(
    true,
  );
  expect(
    new Set(records.workflowReviewRequests!.map((r) => r.requestId)),
  ).toEqual(new Set(ids.map((r) => r.requestId)));
  expect(
    new Set(records.workflowReviewAssignments!.map((r) => r.grantId)),
  ).toEqual(new Set(ids.map((r) => r.grantId)));
  const metadata = JSON.stringify([
    records.workflowReviewRequests,
    records.workflowReviewAssignments,
  ]);
  for (const forbidden of [
    own.adminId,
    own.moderatorId,
    excluded.requestId,
    excluded.grantId,
    original.operationId,
    original.assignKey,
    "Invented export source note",
  ])
    expect(metadata).not.toContain(forbidden);
  expect(
    records.workflowFeedback?.some(
      (r) => r.note === "Invented export source note",
    ),
  ).toBe(true);
});
it("WFREV-07 actual member erasure removes source/request/grant links and reserves anonymous original operation keys", async () => {
  const own = await actors(),
    row = await assigned(own);
  await db.remove(own.memberId);
  expect(await exports.exportOwned(own.member)).toEqual({ kind: "denied" });
  expect(await staff.read(own.moderator, row.grantId)).toEqual({
    kind: "denied",
  });
  for (const table of [
    "workflow_feedback",
    "workflow_review_requests",
    "workflow_review_grants",
  ])
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
    ).toBe(0);
  const tombstones = (
    await pool.query(
      "SELECT actor_id,workspace_id,kind,instruction,receipt_id FROM workflow_review_operations WHERE operation_id=ANY($1::uuid[])",
      [[row.operationId, row.assignKey]],
    )
  ).rows;
  expect(tombstones).toHaveLength(2);
  for (const saved of tombstones)
    expect(saved).toEqual({
      actor_id: null,
      workspace_id: null,
      kind: null,
      instruction: null,
      receipt_id: null,
    });
  const replacement = await actors();
  const checked = await reviews.preview(replacement.member, "WF-001");
  if (checked.kind !== "ready") throw Error("Replacement own preview required");
  expect(
    await reviews.request(replacement.member, {
      checked: checked.preview.checked,
      operationId: row.operationId,
      confirm: "yes",
    }),
  ).toMatchObject({ kind: "conflict" });
  expect(await reviews.inspect(replacement.member, row.operationId)).toEqual({
    kind: "denied",
  });
});
