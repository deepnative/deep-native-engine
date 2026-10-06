import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { migrate, store, hash } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventEnrollmentStore } from "../../src/event-enrollments.ts";
import { eventCancellationStore } from "../../src/event-cancellations.ts";
import type { EventPreview } from "../../src/events.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool);
const event: EventPreview = {
  id: "invented-cancellation-race",
  version: 1,
  title: "Invented last-seat event",
  description: "Invented only",
  agenda: [],
  goals: ["everyday"],
  domainTags: [],
  itRoles: [],
  status: "current",
  startsAt: "2030-11-03T05:30:00.000Z",
  endsAt: "2030-11-03T06:30:00.000Z",
  fixtureCapacity: 1,
  localRegistration: true,
};
const scope = { eventId: event.id, eventVersion: 1 },
  fresh = () => randomBytes(32).toString("hex");
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
function instrument(holdAt?: string, rollback = false) {
  let pid = 0,
    release!: () => void,
    reached!: () => void;
  const held = new Promise<void>((r) => (reached = r)),
    released = new Promise<void>((r) => (release = r));
  const servicePool = {
    connect: async () => {
      const real = await pool.connect();
      pid = (await real.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
        .rows[0]!.pid;
      return new Proxy(real, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              if (holdAt && sql.startsWith(holdAt)) {
                reached();
                await released;
                if (rollback) throw Error("Invented rollback before COMMIT");
              }
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  } as unknown as Pool;
  return { pool: servicePool, held, release: () => release(), pid: () => pid };
}
async function observedWait(holder: () => number, waiter: () => number) {
  const until = performance.now() + 3000;
  while (performance.now() < until) {
    if (
      holder() &&
      waiter() &&
      (
        await pool.query<{ blocked: boolean }>(
          "SELECT $1=ANY(pg_blocking_pids($2)) blocked",
          [holder(), waiter()],
        )
      ).rows[0]?.blocked
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected PostgreSQL row-lock contention was not observed");
}
async function fixture() {
  const member = fresh(),
    admin = fresh();
  await members.create(member, {
    background: "professional",
    goal: "everyday",
  });
  await auth.provisionStaff(
    admin,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  await pool.query(
    "INSERT INTO private_event_inventory(event_id,event_version,title,starts_at,ends_at,capacity) VALUES($1,1,$2,$3,$4,1)",
    [event.id, event.title, event.startsAt, event.endsAt],
  );
  return { member, admin };
}
it.each([false, true])(
  "EVCANCEL-04 enrollment wins the observed inventory lock, rollback=%s",
  async (rollback) => {
    const { member, admin } = await fixture(),
      id = randomUUID(),
      first = instrument("INSERT INTO private_event_enrollments", rollback),
      second = instrument();
    const enrollment = eventEnrollmentStore(first.pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    })
      .enroll(member, event.id, 1, id)
      .then(
        (v) => ({ value: v }),
        () => ({ failed: true }),
      );
    await first.held;
    const cancellation = eventCancellationStore(second.pool, {
      mode: "test",
      writes: true,
      registration: true,
      catalog: [event],
    }).cancel(admin, scope, randomUUID());
    try {
      await observedWait(first.pid, second.pid);
    } finally {
      first.release();
    }
    const enrolled = await enrollment,
      cancelled = await cancellation;
    expect(cancelled.kind).toBe("ready");
    expect(enrolled).toEqual(
      rollback
        ? { failed: true }
        : { value: { kind: "enrolled", receiptId: id } },
    );
    const receipts = (
      await pool.query("SELECT id,withdrawn_at FROM private_event_enrollments")
    ).rows;
    expect(receipts).toEqual(rollback ? [] : [{ id, withdrawn_at: null }]);
    const events = eventEnrollmentStore(pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    });
    if (!rollback)
      expect(await events.receipt(member, id)).toMatchObject({
        id,
        cancelledAt: expect.any(Date),
        withdrawnAt: null,
      });
    expect((await events.enroll(member, event.id, 1, randomUUID())).kind).toBe(
      rollback ? "unavailable" : "already-enrolled",
    );
  },
);
it.each([false, true])(
  "EVCANCEL-04 cancellation wins the observed inventory lock, rollback=%s",
  async (rollback) => {
    const { member, admin } = await fixture(),
      id = randomUUID(),
      first = instrument("UPDATE private_event_cancellation_state", rollback),
      second = instrument();
    const cancellation = eventCancellationStore(first.pool, {
      mode: "test",
      writes: true,
      registration: true,
      catalog: [event],
    }).cancel(admin, scope, randomUUID());
    await first.held;
    const enrollment = eventEnrollmentStore(second.pool, {
      mode: "test",
      enabled: true,
      catalog: [event],
    }).enroll(member, event.id, 1, id);
    try {
      await observedWait(first.pid, second.pid);
    } finally {
      first.release();
    }
    expect((await cancellation).kind).toBe(rollback ? "unavailable" : "ready");
    expect(await enrollment).toEqual(
      rollback ? { kind: "enrolled", receiptId: id } : { kind: "unavailable" },
    );
    expect(
      (await pool.query("SELECT id FROM private_event_enrollments")).rows,
    ).toEqual(rollback ? [{ id }] : []);
    expect(
      (await pool.query("SELECT id FROM private_event_cancellations")).rows,
    ).toHaveLength(rollback ? 0 : 1);
    // A different version retains independent enrollment and capacity.
    const other = { ...event, version: 2 };
    expect(
      (
        await eventEnrollmentStore(pool, {
          mode: "test",
          enabled: true,
          catalog: [other],
        }).enroll(member, event.id, 2, randomUUID())
      ).kind,
    ).toBe("enrolled");
  },
);

it.each(["revoked", "token-replaced", "role-changed"])(
  "EVCANCEL-05 rechecks %s when selected authority waits on the actual row lock",
  async (change) => {
    const { admin } = await fixture();
    const actor = (
      await pool.query<{ id: string }>(
        "SELECT id FROM principals WHERE token_hash=$1",
        [hash(admin)],
      )
    ).rows[0]!.id;
    const holder = await pool.connect(),
      waiting = instrument();
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid")
    ).rows[0]!.pid;
    try {
      await holder.query("BEGIN");
      await holder.query(
        change === "role-changed"
          ? "SELECT principal_id FROM staff_profiles WHERE principal_id=$1 FOR UPDATE"
          : "SELECT id FROM principals WHERE id=$1 FOR UPDATE",
        [actor],
      );
      const pending = eventCancellationStore(waiting.pool, {
        mode: "test",
        writes: true,
        registration: true,
        catalog: [event],
      }).cancel(admin, scope, randomUUID());
      await observedWait(() => pid, waiting.pid);
      if (change === "revoked")
        await holder.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [actor],
        );
      else if (change === "token-replaced")
        await holder.query("UPDATE principals SET token_hash=$2 WHERE id=$1", [
          actor,
          hash(fresh()),
        ]);
      else
        await holder.query(
          "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
          [actor],
        );
      await holder.query("COMMIT");
      expect(await pending).toEqual({ kind: "denied" });
      expect(
        (await pool.query("SELECT id FROM private_event_cancellations")).rows,
      ).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  },
);
it("EVCANCEL-05 finite selected authority cannot cancel after expiring in an observed inventory wait", async () => {
  const { admin } = await fixture();
  const expiry = (
    await pool.query<{ expires_at: Date }>(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1 RETURNING expires_at",
      [hash(admin)],
    )
  ).rows[0]!.expires_at;
  const holder = await pool.connect(),
    waiting = instrument(),
    pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() pid"))
      .rows[0]!.pid;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT event_id FROM private_event_inventory WHERE event_id=$1 AND event_version=1 FOR UPDATE",
      [event.id],
    );
    const pending = eventCancellationStore(waiting.pool, {
      mode: "test",
      writes: true,
      registration: true,
      catalog: [event],
    }).cancel(admin, scope, randomUUID());
    await observedWait(() => pid, waiting.pid);
    const until = performance.now() + 3000;
    let expired = false;
    while (performance.now() < until) {
      expired = (
        await pool.query<{ expired: boolean }>(
          "SELECT clock_timestamp()>$1::timestamptz expired",
          [expiry],
        )
      ).rows[0]!.expired;
      if (expired) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(
      expired,
      "Actual database authority deadline passed while inventory remained held",
    ).toBe(true);
    await holder.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
    expect(
      (await pool.query("SELECT id FROM private_event_cancellations")).rows,
    ).toEqual([]);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
});
