import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
const event = "invented-cancellation-migration";
const migration = () =>
  readFile(
    new URL(
      "../../migrations/062-private-event-cancellation.sql",
      import.meta.url,
    ),
    "utf8",
  );
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "professional", goal: "everyday" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Missing invented member");
  const workspace = (
    await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1",
      [session.learner.id],
    )
  ).rows[0]!.id;
  return { id: session.learner.id, workspace };
}
async function inventory() {
  await pool.query(
    "INSERT INTO private_event_inventory(event_id,event_version,title,starts_at,ends_at,capacity) VALUES($1,1,'Invented cancellation rehearsal','2030-11-03T05:30:00Z','2030-11-03T06:30:00Z',1)",
    [event],
  );
}
async function enrollment(owner: Awaited<ReturnType<typeof member>>) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO private_event_enrollments(id,member_id,workspace_id,event_id,event_version,capacity,seat_number) VALUES($1,$2,$3,$4,1,1,1)",
    [id, owner.id, owner.workspace, event],
  );
  return id;
}
async function cancel() {
  const actor = await auth.provisionStaff(
      randomBytes(32).toString("hex"),
      "platform_admin",
      new Date(Date.now() + 3600000),
    ),
    id = randomUUID(),
    key = randomUUID(),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout=5000");
    await client.query(
      "SELECT event_id FROM private_event_inventory WHERE event_id=$1 AND event_version=1 FOR UPDATE",
      [event],
    );
    await client.query(
      "SELECT event_id FROM private_event_cancellation_state WHERE event_id=$1 AND event_version=1 FOR UPDATE",
      [event],
    );
    await client.query(
      "INSERT INTO private_event_cancellations(id,event_id,event_version,cancelled_at) VALUES($1,$2,1,clock_timestamp())",
      [id, event],
    );
    await client.query(
      "UPDATE private_event_cancellation_state SET cancellation_id=$1 WHERE event_id=$2 AND event_version=1",
      [id, event],
    );
    await client.query(
      "INSERT INTO private_event_cancellation_operations(idempotency_key,actor_id,event_id,event_version,cancellation_id,action) VALUES($1,$2,$3,1,$4,'cancelled')",
      [key, actor, event, id],
    );
    await client.query("COMMIT");
    return { id, key, actor };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
it("EVCANCEL-08 upgrades populated legacy inventory and owned receipts without changing their identity, and safely reapplies", async () => {
  await pool.query(
    "DROP TRIGGER private_event_enrollment_cancellation_fence ON private_event_enrollments; DROP TRIGGER private_event_cancellation_state_initialize ON private_event_inventory; DROP TABLE private_event_cancellation_operations,private_event_cancellation_state,private_event_cancellations CASCADE; DELETE FROM schema_migrations WHERE version=62",
  );
  try {
    const owner = await member();
    await inventory();
    const id = await enrollment(owner);
    const before = (
      await pool.query("SELECT * FROM private_event_enrollments WHERE id=$1", [
        id,
      ])
    ).rows;
    const sql = await migration();
    await pool.query(sql);
    await pool.query(sql);
    expect(
      (
        await pool.query(
          "SELECT * FROM private_event_enrollments WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT cancellation_id FROM private_event_cancellation_state WHERE event_id=$1",
          [event],
        )
      ).rows,
    ).toEqual([{ cancellation_id: null }]);
    expect(
      (
        await pool.query(
          "SELECT version FROM schema_migrations WHERE version=62",
        )
      ).rows,
    ).toEqual([{ version: 62 }]);
  } finally {
    await pool.query(await migration());
  }
});
it("EVCANCEL-04/07 retains the enrolled member's receipt while committed cancellation fences direct legacy insertion and survives actor and member erasure", async () => {
  const owner = await member(),
    other = await member();
  await inventory();
  const receipt = await enrollment(owner),
    c = await cancel();
  expect(
    (
      await pool.query(
        "SELECT id,withdrawn_at FROM private_event_enrollments WHERE id=$1",
        [receipt],
      )
    ).rows,
  ).toEqual([{ id: receipt, withdrawn_at: null }]);
  await expect(enrollment(other)).rejects.toThrow(
    "Private event registration unavailable",
  );
  await pool.query("DELETE FROM principals WHERE id=$1", [c.actor]);
  expect(
    (
      await pool.query(
        "SELECT actor_id,cancellation_id FROM private_event_cancellation_operations WHERE idempotency_key=$1",
        [c.key],
      )
    ).rows,
  ).toEqual([{ actor_id: null, cancellation_id: c.id }]);
  await members.remove(owner.id);
  expect(
    (
      await pool.query("SELECT id FROM private_event_enrollments WHERE id=$1", [
        receipt,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT cancellation_id FROM private_event_cancellation_state WHERE event_id=$1",
        [event],
      )
    ).rows,
  ).toEqual([{ cancellation_id: c.id }]);
  await expect(enrollment(other)).rejects.toThrow(
    "Private event registration unavailable",
  );
});
it("EVCANCEL-04/08 rejects direct reactivation, deletion and orphan cancellation facts", async () => {
  await inventory();
  const c = await cancel();
  await expect(
    pool.query(
      "UPDATE private_event_cancellation_state SET cancellation_id=NULL WHERE event_id=$1",
      [event],
    ),
  ).rejects.toThrow("one way");
  await expect(
    pool.query("DELETE FROM private_event_cancellations WHERE id=$1", [c.id]),
  ).rejects.toThrow("immutable");
  await expect(
    pool.query("DELETE FROM private_event_inventory WHERE event_id=$1", [
      event,
    ]),
  ).rejects.toThrow();
  const second = "invented-orphan-event";
  await pool.query(
    "INSERT INTO private_event_inventory(event_id,event_version,title,starts_at,ends_at,capacity) VALUES($1,1,'Invented orphan','2030-11-03T05:30:00Z','2030-11-03T06:30:00Z',1)",
    [second],
  );
  await expect(
    pool.query(
      "INSERT INTO private_event_cancellations(id,event_id,event_version,cancelled_at) VALUES($1,$2,1,clock_timestamp())",
      [randomUUID(), second],
    ),
  ).rejects.toThrow("monotonic fence");
});

it.each(["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const)(
  "EVCANCEL-04 legacy %s snapshot cannot enroll after cancellation has committed",
  async (isolation) => {
    const owner = await member();
    await inventory();
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      expect(
        (
          await client.query(
            "SELECT cancellation_id FROM private_event_cancellation_state WHERE event_id=$1",
            [event],
          )
        ).rows,
      ).toEqual([{ cancellation_id: null }]);
      await cancel();
      await expect(
        client.query(
          "INSERT INTO private_event_enrollments(id,member_id,workspace_id,event_id,event_version,capacity,seat_number) VALUES($1,$2,$3,$4,1,1,1)",
          [randomUUID(), owner.id, owner.workspace, event],
        ),
      ).rejects.toMatchObject({
        code: isolation === "READ COMMITTED" ? "P0001" : "40001",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(
      (
        await pool.query(
          "SELECT id FROM private_event_enrollments WHERE member_id=$1",
          [owner.id],
        )
      ).rows,
    ).toEqual([]);
  },
);

it("EVCANCEL-04/07 cancellation does not wait for an attendee workspace held ahead of a direct legacy enrollment", async () => {
  const owner = await member();
  await inventory();
  const holder = await pool.connect();
  let pending: Promise<{ error?: unknown }> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
      owner.workspace,
    ]);
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid")
    ).rows[0]!.pid;
    pending = enrollment(owner).then(
      () => ({}),
      (error) => ({ error }),
    );
    let observed = false;
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      observed = (
        await pool.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) blocked",
          [pid],
        )
      ).rows[0]!.blocked;
      if (observed) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(
      observed,
      "Observe the actual direct writer waiting on its FK workspace before inventory",
    ).toBe(true);
    const cancelled = await cancel();
    expect(
      (
        await pool.query(
          "SELECT cancellation_id FROM private_event_cancellation_state WHERE event_id=$1",
          [event],
        )
      ).rows,
    ).toEqual([{ cancellation_id: cancelled.id }]);
    await holder.query("COMMIT");
    expect((await pending).error).toMatchObject({ code: "P0001" });
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    if (pending) await pending;
  }
}, 15000);
it("EVCANCEL-08 cannot commit a first cancellation without its compatible creator operation", async () => {
  await inventory();
  const actor = await auth.provisionStaff(
      randomBytes(32).toString("hex"),
      "platform_admin",
      new Date(Date.now() + 3600000),
    ),
    id = randomUUID(),
    key = randomUUID(),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT event_id FROM private_event_inventory WHERE event_id=$1 AND event_version=1 FOR UPDATE",
      [event],
    );
    await client.query(
      "INSERT INTO private_event_cancellations(id,event_id,event_version,cancelled_at) VALUES($1,$2,1,clock_timestamp())",
      [id, event],
    );
    await client.query(
      "UPDATE private_event_cancellation_state SET cancellation_id=$1 WHERE event_id=$2 AND event_version=1",
      [id, event],
    );
    await client.query(
      "INSERT INTO private_event_cancellation_operations(idempotency_key,actor_id,event_id,event_version,cancellation_id,action,created_at) VALUES($1,$2,$3,1,$4,'already-cancelled',clock_timestamp())",
      [key, actor, event, id],
    );
    await expect(client.query("COMMIT")).rejects.toThrow();
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  expect(
    (await pool.query("SELECT id FROM private_event_cancellations")).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT cancellation_id FROM private_event_cancellation_state WHERE event_id=$1",
        [event],
      )
    ).rows,
  ).toEqual([{ cancellation_id: null }]);
  const canonical = await cancel();
  expect(
    (await pool.query("SELECT id FROM private_event_cancellations")).rows,
  ).toEqual([{ id: canonical.id }]);
});
