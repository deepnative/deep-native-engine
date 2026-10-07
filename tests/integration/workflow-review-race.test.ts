import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate } from "../../src/store.ts";
import { workflowReviewStaffStore } from "../../src/workflow-review-staff.ts";
import { testPool } from "../support/database.ts";
import { waitForSampleAssignmentBlock } from "../support/sample-assignment.ts";
import {
  workflowReviewFixture,
  WORKFLOW_REVIEW_TEST_SECRET,
} from "../support/workflow-review.ts";
const pool = testPool();
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
const changes = [
  "permission withdrawal",
  "source correction",
  "source withdrawal/recreation",
  "moderator revocation",
  "administrator role change",
] as const;
type Change = (typeof changes)[number];
type Fixture = Awaited<ReturnType<typeof workflowReviewFixture>>;
async function change(f: Fixture, kind: Change) {
  if (kind === "permission withdrawal")
    return f.reviews.withdraw(f.member, f.requestId, randomUUID(), "yes");
  if (kind === "source correction")
    return f.feedback.save(
      f.member,
      "WF-001",
      1,
      "Invented corrected private note",
      1,
    );
  if (kind === "source withdrawal/recreation") {
    expect(await f.feedback.withdraw(f.member, "WF-001", 1, 1)).toBe(true);
    return f.feedback.save(f.member, "WF-001", 1, f.note, 0);
  }
  if (kind === "moderator revocation")
    return pool.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.moderatorId],
    );
  return pool.query(
    "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
    [f.adminId],
  );
}
it.each(changes)(
  "WFREV-04/05/06 protected read owning its real fences precedes %s and later reads deny",
  async (kind) => {
    const f = await workflowReviewFixture(pool),
      entered = gate(),
      resume = gate();
    let pid = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid as number;
        return {
          query: (async (sql: string, values?: unknown[]) => {
            if (sql.startsWith("SELECT note FROM workflow_feedback")) {
              entered.release();
              await resume.wait;
            }
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const reader = workflowReviewStaffStore(
      scoped,
      { enabled: true, mode: "test" },
      WORKFLOW_REVIEW_TEST_SECRET,
    );
    const reading = reader.read(f.moderator, f.grantId);
    let changing: Promise<unknown> | undefined;
    try {
      await entered.wait;
      changing = change(f, kind);
      await waitForSampleAssignmentBlock(pool, pid);
      resume.release();
      expect(await reading).toMatchObject({ kind: "ready", note: f.note });
      const changed = await changing;
      if (kind === "permission withdrawal")
        expect(changed).toMatchObject({
          kind: "applied",
          receipt: { state: "withdrawn" },
        });
      if (
        kind === "source correction" ||
        kind === "source withdrawal/recreation"
      )
        expect(changed).toBe(true);
      expect(await f.staff.read(f.moderator, f.grantId)).toEqual({
        kind: "denied",
      });
    } finally {
      resume.release();
      await Promise.allSettled([reading, ...(changing ? [changing] : [])]);
    }
  },
);
it.each(changes)(
  "WFREV-04/05/06 committed %s owning its fence denies the observed waiting reader",
  async (kind) => {
    const f = await workflowReviewFixture(pool),
      holder = await pool.connect();
    let open = false,
      reading: ReturnType<typeof f.staff.read> | undefined;
    try {
      await holder.query("BEGIN");
      open = true;
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      if (kind === "permission withdrawal")
        await holder.query(
          "UPDATE workflow_review_requests SET withdrawn_at=clock_timestamp() WHERE id=$1",
          [f.requestId],
        );
      else if (kind === "source correction")
        await holder.query(
          "UPDATE workflow_feedback SET note='Invented corrected private note',revision=revision+1 WHERE member_id=$1",
          [f.memberId],
        );
      else if (kind === "source withdrawal/recreation") {
        await holder.query("DELETE FROM workflow_feedback WHERE member_id=$1", [
          f.memberId,
        ]);
        await holder.query(
          "INSERT INTO workflow_feedback(member_id,workflow_id,workflow_version,note,revision) VALUES($1,'WF-001',1,$2,1)",
          [f.memberId, f.note],
        );
      } else if (kind === "moderator revocation")
        await holder.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.moderatorId],
        );
      else
        await holder.query(
          "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
          [f.adminId],
        );
      reading = f.staff.read(f.moderator, f.grantId);
      await waitForSampleAssignmentBlock(pool, pid);
      await holder.query("COMMIT");
      open = false;
      expect(await reading).toEqual({ kind: "denied" });
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled(reading ? [reading] : []);
    }
  },
);
