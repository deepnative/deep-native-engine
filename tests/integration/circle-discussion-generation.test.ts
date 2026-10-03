import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { circleStore } from "../../src/circles.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  circles = circleStore(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => pool.query("TRUNCATE principals CASCADE"));
afterAll(async () => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  expect(await circles.join(token, "everyday-ai")).toBe("joined");
  return { token, id: session.learner.id };
}
it("rejects an incompatible legacy rejoin instead of reusing an old sharing generation", async () => {
  const a = await member();
  expect(await circles.leave(a.token, "everyday-ai")).toBe(true);
  await expect(
    pool.query(
      `INSERT INTO preview_circle_memberships(circle_id,member_id)
    VALUES('everyday-ai',$1) ON CONFLICT(circle_id,member_id) DO UPDATE
    SET joined_at=clock_timestamp(),left_at=NULL`,
      [a.id],
    ),
  ).rejects.toThrow();
  expect(
    (
      await pool.query(
        "SELECT generation,left_at IS NOT NULL AS departed FROM preview_circle_memberships WHERE member_id=$1",
        [a.id],
      )
    ).rows,
  ).toEqual([{ generation: "1", departed: true }]);
  expect(await circles.join(a.token, "everyday-ai")).toBe("joined");
});
it("retains the exact closed interval across genuine and repeated rejoin and exports only its owner's history", async () => {
  const a = await member(),
    b = await member();
  expect(await circles.leave(a.token, "everyday-ai")).toBe(true);
  const closed = (
    await pool.query(
      "SELECT circle_id,generation,joined_at,left_at FROM preview_circle_memberships WHERE member_id=$1",
      [a.id],
    )
  ).rows;
  expect(await circles.join(a.token, "everyday-ai")).toBe("joined");
  expect(await circles.join(a.token, "everyday-ai")).toBe("joined");
  expect(
    (
      await pool.query(
        "SELECT circle_id,generation,joined_at,left_at FROM preview_circle_membership_history WHERE member_id=$1",
        [a.id],
      )
    ).rows,
  ).toEqual(closed);
  const owned = await memberExportStore(pool).exportOwned(a.token);
  if (owned.kind !== "ready") throw Error("Owned export unavailable");
  expect(owned.payload.records.circleMembershipHistory).toEqual([
    {
      circleId: closed[0].circle_id,
      generation: "1",
      joinedAt: closed[0].joined_at,
      leftAt: closed[0].left_at,
    },
  ]);
  const peer = await memberExportStore(pool).exportOwned(b.token);
  if (peer.kind !== "ready") throw Error("Peer export unavailable");
  expect(peer.payload.records.circleMembershipHistory).toEqual([]);
  expect(await circles.leave(a.token, "everyday-ai")).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT generation FROM preview_circle_membership_history WHERE member_id=$1 ORDER BY generation",
        [a.id],
      )
    ).rows,
  ).toEqual([{ generation: "1" }, { generation: "2" }]);
});
it("prevents history rewriting and erases only the departing owner's intervals", async () => {
  const a = await member(),
    b = await member();
  await circles.leave(a.token, "everyday-ai");
  await circles.leave(b.token, "everyday-ai");
  await expect(
    pool.query(
      "UPDATE preview_circle_membership_history SET left_at=clock_timestamp() WHERE member_id=$1",
      [a.id],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query(
      "DELETE FROM preview_circle_membership_history WHERE member_id=$1",
      [a.id],
    ),
  ).rejects.toThrow();
  await pool.query("DELETE FROM workspaces WHERE owner_principal_id=$1", [
    a.id,
  ]);
  expect(
    (
      await pool.query(
        "SELECT member_id FROM preview_circle_membership_history",
      )
    ).rows,
  ).toEqual([{ member_id: b.id }]);
});

it("dates a rejoin after a leave that completes while its transaction waits for the circle lock", async () => {
  const a = await member();
  const blocker = await pool.connect(),
    waiter = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(7529,hashtext('everyday-ai'))",
    );
    const pid = (await waiter.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    const borrowed = {
      connect: async () => ({ query: waiter.query.bind(waiter), release() {} }),
    } as unknown as Pool;
    pending = circleStore(borrowed).join(a.token, "everyday-ai");
    const deadline = Date.now() + 2000;
    let waiting = false;
    while (Date.now() < deadline) {
      const row = (
        await pool.query("SELECT cardinality(pg_blocking_pids($1))>0 waiting", [
          pid,
        ])
      ).rows[0];
      if (row.waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      waiting,
      "The actual rejoin must wait before the concurrent leave",
    ).toBe(true);
    expect(await circles.leave(a.token, "everyday-ai")).toBe(true);
    const closed = (
      await pool.query(
        "SELECT left_at FROM preview_circle_memberships WHERE member_id=$1",
        [a.id],
      )
    ).rows[0].left_at;
    await blocker.query("COMMIT");
    expect(await pending).toBe("joined");
    const current = (
      await pool.query(
        "SELECT generation,joined_at FROM preview_circle_memberships WHERE member_id=$1",
        [a.id],
      )
    ).rows[0];
    expect(current.generation).toBe("2");
    expect(current.joined_at.getTime()).toBeGreaterThanOrEqual(
      closed.getTime(),
    );
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled(pending ? [pending] : []);
    blocker.release();
    waiter.release();
  }
});
