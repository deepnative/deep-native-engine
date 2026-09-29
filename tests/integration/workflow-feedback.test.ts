import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { workflowFeedbackStore } from "../../src/workflow-feedback.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const feedback = workflowFeedbackStore(pool);
const token = () => randomBytes(32).toString("hex");

async function member(background: "explorer" | "professional" | "technical") {
  const value = token();
  await db.create(value, {
    background,
    goal: background === "explorer" ? "everyday" : "work",
  });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  return {
    token: value,
    id: session.kind === "active" ? session.learner.id : "",
  };
}

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

it("keeps versioned feedback private across three learner backgrounds and handles conflicting writes", async () => {
  const people = await Promise.all([
    member("explorer"),
    member("professional"),
    member("technical"),
  ]);
  for (const person of people) {
    expect(
      await feedback.save(
        person.token,
        "WF-001",
        1,
        "  Invented workflow detail  ",
        0,
      ),
    ).toBe(true);
    expect(await feedback.list(person.token)).toMatchObject([
      {
        workflowId: "WF-001",
        workflowVersion: 1,
        note: "Invented workflow detail",
        revision: 1,
      },
    ]);
  }
  const owner = people[0]!;
  const other = people[1]!;
  const concurrent = await Promise.all([
    feedback.save(owner.token, "WF-001", 1, "First correction", 1),
    feedback.save(owner.token, "WF-001", 1, "Second correction", 1),
  ]);
  expect(concurrent.sort()).toEqual([false, true]);
  expect(await feedback.list(owner.token)).toMatchObject([{ revision: 2 }]);
  expect(await feedback.list(other.token)).toMatchObject([
    { note: "Invented workflow detail", revision: 1 },
  ]);
  expect(await feedback.withdraw(other.token, "WF-001", 1, 2)).toBe(false);
  expect(await feedback.withdraw(owner.token, "WF-001", 1, 1)).toBe(false);
  expect(await feedback.withdraw(owner.token, "WF-001", 1, 2)).toBe(true);
  expect(await feedback.list(owner.token)).toEqual([]);
  expect(await feedback.list(other.token)).toHaveLength(1);
});

it("rejects unknown versions and staff, revocation and expiry while retaining only owner export", async () => {
  const owner = await member("professional");
  const outsider = await member("technical");
  const staff = token();
  await authorizationStore(pool).provisionStaff(
    staff,
    "reviewer",
    new Date(Date.now() + 86_400_000),
  );
  expect(await feedback.save(owner.token, "WF-999", 1, "Invented", 0)).toBe(
    false,
  );
  expect(await feedback.save(owner.token, "WF-001", 2, "Invented", 0)).toBe(
    false,
  );
  expect(await feedback.save(staff, "WF-001", 1, "Invented", 0)).toBe(false);
  expect(await feedback.list(staff)).toEqual([]);
  expect(await feedback.save(owner.token, "WF-001", 1, "Invented", 0)).toBe(
    true,
  );
  const own = await memberExportStore(pool).exportOwned(owner.token);
  expect(own).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v9",
      records: {
        workflowFeedback: [
          { workflowId: "WF-001", workflowVersion: 1, note: "Invented" },
        ],
      },
    },
  });
  const unrelated = await memberExportStore(pool).exportOwned(outsider.token);
  expect(unrelated).toMatchObject({
    kind: "ready",
    payload: { records: { workflowFeedback: [] } },
  });
  await pool.query(
    `UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [owner.id],
  );
  expect(await feedback.list(owner.token)).toEqual([]);
  expect(await feedback.withdraw(owner.token, "WF-001", 1, 1)).toBe(false);
  await pool.query("UPDATE principals SET revoked_at=NULL WHERE id=$1", [
    owner.id,
  ]);
  await pool.query(
    `UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1`,
    [owner.id],
  );
  expect(await feedback.list(owner.token)).toEqual([]);
  expect(await feedback.save(owner.token, "WF-001", 1, "Changed", 1)).toBe(
    false,
  );
  await pool.query("DELETE FROM learners WHERE id=$1", [owner.id]);
  expect(
    (
      await pool.query("SELECT 1 FROM workflow_feedback WHERE member_id=$1", [
        owner.id,
      ])
    ).rowCount,
  ).toBe(0);
});

it("shows retained historical versions without silently copying a note to the current file", async () => {
  const owner = await member("explorer");
  await pool.query(
    `INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note)
     VALUES($1,'WF-002',2,'Invented historical version note')`,
    [owner.id],
  );
  expect(await feedback.list(owner.token)).toMatchObject([
    {
      workflowId: "WF-002",
      workflowVersion: 2,
      note: "Invented historical version note",
    },
  ]);
  expect(await feedback.save(owner.token, "WF-002", 2, "Changed", 1)).toBe(
    false,
  );
  expect(await feedback.save(owner.token, "WF-002", 1, "Current note", 0)).toBe(
    true,
  );
  expect(await feedback.list(owner.token)).toHaveLength(2);
  expect(await feedback.withdraw(owner.token, "WF-002", 2, 1)).toBe(true);
  expect(await feedback.list(owner.token)).toMatchObject([
    { workflowVersion: 1, note: "Current note" },
  ]);
});
