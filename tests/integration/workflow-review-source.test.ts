import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const feedback = workflowFeedbackStore(pool);
beforeAll(async () => migrate(pool));
afterAll(async () => pool.end());

it("WFREV-04 correction preserves source identity but identical-text recreation cannot reuse it", async () => {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  expect(session.kind).toBe("active");
  if (session.kind !== "active") throw new Error("Invented member unavailable");
  const identity = async () =>
    (
      await pool.query<{ instance: string | null }>(
        `SELECT to_jsonb(f)->>'instance_id' AS instance FROM workflow_feedback f
         WHERE member_id=$1 AND workflow_id='WF-001' AND workflow_version=1`,
        [session.learner.id],
      )
    ).rows[0]?.instance;
  const note = "Invented identical source text";
  expect(await feedback.save(token, "WF-001", 1, note, 0)).toBe(true);
  const first = await identity();
  expect(first).toEqual(
    expect.stringMatching(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    ),
  );
  expect(await feedback.save(token, "WF-001", 1, note, 1)).toBe(true);
  expect(await identity()).toBe(first);
  expect(await feedback.withdraw(token, "WF-001", 1, 2)).toBe(true);
  expect(await feedback.save(token, "WF-001", 1, note, 0)).toBe(true);
  const replacement = await identity();
  expect(replacement).toEqual(expect.any(String));
  expect(replacement).not.toBe(first);
  expect((await feedback.list(token))?.[0]).toMatchObject({
    note,
    revision: 1,
  });
});
