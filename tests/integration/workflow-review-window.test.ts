import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  secret = "invented-workflow-window-secret",
  options = { enabled: true, mode: "test" as const };
const reviews = workflowReviewStore(pool, options, secret),
  staff = workflowReviewStaffStore(pool, options, secret),
  fresh = () => randomBytes(32).toString("hex");
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
it("WFREV-02/05 future canonical UTC assignment cannot expose the note before its checked start", async () => {
  const member = fresh(),
    admin = fresh(),
    moderator = fresh();
  await store(pool).create(member, { background: "technical", goal: "work" });
  const auth = authorizationStore(pool);
  await auth.provisionStaff(
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
      "Invented scheduled private note",
      0,
    ),
  ).toBe(true);
  const preview = await reviews.preview(member, "WF-001");
  if (preview.kind !== "ready") throw Error("Member preview required");
  const intent = await reviews.request(member, {
    checked: preview.preview.checked,
    operationId: randomUUID(),
    confirm: "yes",
  });
  if (intent.kind !== "applied") throw Error("Member permission required");
  const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0]
    .now as Date;
  const window = {
    startsAt: new Date(+now + 600000).toISOString(),
    expiresAt: new Date(+now + 1200000).toISOString(),
  };
  const checked = await staff.check(
    admin,
    intent.receipt.requestId,
    moderatorId,
    window,
  );
  expect(checked.kind).toBe("ready");
  if (checked.kind !== "ready") throw Error("Checked finite window required");
  expect.soft(checked.startsAt).toBe(window.startsAt);
  expect.soft(checked.expiresAt).toBe(window.expiresAt);
  for (const bad of [
    { startsAt: window.expiresAt, expiresAt: window.startsAt },
    {
      startsAt: window.startsAt.replace("Z", "+00:00"),
      expiresAt: window.expiresAt,
    },
    {
      startsAt: window.startsAt,
      expiresAt: new Date(+now + 7200000).toISOString(),
    },
  ])
    expect(
      await staff.check(admin, intent.receipt.requestId, moderatorId, bad),
    ).toMatchObject({ kind: "invalid" });
  const assigned = await staff.assign(
    admin,
    checked.checked,
    randomUUID(),
    "yes",
  );
  expect(assigned.kind).toBe("applied");
  if (assigned.kind !== "applied") throw Error("Scheduled assignment required");
  expect
    .soft(await staff.read(moderator, assigned.grant.grantId))
    .toEqual({ kind: "denied" });
  const receipt = await staff.receipt(admin, assigned.grant.grantId);
  expect(receipt.kind).toBe("ready");
  if (receipt.kind !== "ready") throw Error("Scheduled receipt required");
  expect.soft(receipt.grant.state).toBe("scheduled");
});
