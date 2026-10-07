import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  fresh = () => randomBytes(32).toString("hex"),
  secret = "invented-workflow-migration-secret";
afterAll(() => pool.end());
it("WFREV-08 populated migration063 upgrades without rewriting notes or inventing permissions and full reapply preserves existing identities/windows", async () => {
  const directory = new URL("../../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((n) => /^\d{3}-.+\.sql$/.test(n) && Number(n.slice(0, 3)) <= 63)
    .sort())
    await pool.query(await readFile(new URL(name, directory), "utf8"));
  const member = fresh(),
    other = fresh(),
    db = store(pool),
    feedback = workflowFeedbackStore(pool);
  await db.create(member, { background: "technical", goal: "work" });
  await db.create(other, { background: "explorer", goal: "everyday" });
  expect(
    await feedback.save(member, "WF-001", 1, "Invented populated note", 0),
  ).toBe(true);
  expect(
    await feedback.save(
      member,
      "WF-001",
      1,
      "Invented populated correction",
      1,
    ),
  ).toBe(true);
  expect(
    await feedback.save(other, "WF-001", 1, "Invented other populated note", 0),
  ).toBe(true);
  const notes = async () =>
    (
      await pool.query(
        "SELECT member_id,workflow_id,workflow_version,note,revision,created_at,updated_at FROM workflow_feedback ORDER BY member_id",
      )
    ).rows;
  const before = await notes();
  await pool.query(
    await readFile(
      new URL("064-workflow-feedback-instance.sql", directory),
      "utf8",
    ),
  );
  await pool.query(
    await readFile(
      new URL("065-private-workflow-review.sql", directory),
      "utf8",
    ),
  );
  expect(await notes()).toEqual(before);
  const identities = (
    await pool.query(
      "SELECT member_id,instance_id FROM workflow_feedback ORDER BY member_id",
    )
  ).rows;
  expect(new Set(identities.map((r) => r.instance_id)).size).toBe(2);
  for (const table of [
    "workflow_review_requests",
    "workflow_review_grants",
    "workflow_review_operations",
  ])
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
    ).toBe(0);
  const identity = identities[0]!;
  await expect(
    pool.query(
      "UPDATE workflow_feedback SET instance_id=$1 WHERE member_id=$2",
      [randomUUID(), identity.member_id],
    ),
  ).rejects.toMatchObject({ code: "P0001" });
  const admin = fresh(),
    moderator = fresh(),
    auth = authorizationStore(pool);
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
  const reviews = workflowReviewStore(
      pool,
      { enabled: true, mode: "test" },
      secret,
    ),
    staff = workflowReviewStaffStore(
      pool,
      { enabled: true, mode: "test" },
      secret,
    );
  const preview = await reviews.preview(member, "WF-001");
  if (preview.kind !== "ready") throw Error("Upgraded member preview required");
  const intent = await reviews.request(member, {
    checked: preview.preview.checked,
    operationId: randomUUID(),
    confirm: "yes",
  });
  if (intent.kind !== "applied") throw Error("Upgraded permission required");
  const checked = await staff.check(
    admin,
    intent.receipt.requestId,
    moderatorId,
  );
  if (checked.kind !== "ready") throw Error("Checked upgraded window required");
  const assigned = await staff.assign(
    admin,
    checked.checked,
    randomUUID(),
    "yes",
  );
  if (assigned.kind !== "applied") throw Error("Exact upgraded grant required");
  const snapshot = async () => ({
    source: (
      await pool.query("SELECT * FROM workflow_feedback ORDER BY member_id")
    ).rows,
    requests: (
      await pool.query("SELECT * FROM workflow_review_requests ORDER BY id")
    ).rows,
    grants: (
      await pool.query("SELECT * FROM workflow_review_grants ORDER BY id")
    ).rows,
    operations: (
      await pool.query(
        "SELECT * FROM workflow_review_operations ORDER BY operation_id",
      )
    ).rows,
  });
  const populated = await snapshot();
  await migrate(pool);
  expect(await snapshot()).toEqual(populated);
  expect(await notes()).toEqual(before);
  const paused = workflowReviewStaffStore(
    pool,
    { enabled: false, mode: "test" },
    secret,
  );
  expect(
    await paused.check(admin, intent.receipt.requestId, moderatorId),
  ).toEqual({ kind: "unavailable" });
  expect(
    await paused.assign(admin, checked.checked, randomUUID(), "yes"),
  ).toEqual({ kind: "unavailable" });
  expect(await paused.read(moderator, assigned.grant.grantId)).toMatchObject({
    kind: "ready",
    note: "Invented populated correction",
  });
  expect(
    await paused.revoke(admin, assigned.grant.grantId, randomUUID(), "yes"),
  ).toMatchObject({ kind: "applied" });
  expect(await paused.read(moderator, assigned.grant.grantId)).toEqual({
    kind: "denied",
  });
});
