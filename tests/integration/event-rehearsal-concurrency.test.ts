import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { migrate, hash } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  auth = authorizationStore(pool);
const fresh = () => randomBytes(32).toString("hex");
const checked = () =>
  rehearsalSnapshot({
    templateId: "local-registration-rehearsal",
    templateVersion: 1,
    startsAt: new Date(Date.now() + 3600000).toISOString(),
  })!;
const scheduling = (db = pool) =>
  eventRehearsalStore(db, { mode: "test", writes: true, registration: true });
async function administrator() {
  const token = fresh();
  await auth.provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  return token;
}
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
function instrument(
  holdAt?: string,
  rollback = false,
  isolation:
    "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "READ COMMITTED",
) {
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
              const result = await target.query(
                sql === "BEGIN" ? `BEGIN ISOLATION LEVEL ${isolation}` : sql,
                values,
              );
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

it("REHSCHED-04 observed concurrent final admission admits only one of two exact instructions", async () => {
  const token = await administrator(),
    snapshot = checked();
  for (let i = 0; i < 19; i++)
    expect(
      (await scheduling().schedule(token, randomUUID(), snapshot)).kind,
    ).toBe("ready");
  const first = instrument("INSERT INTO private_event_rehearsals"),
    second = instrument();
  const a = scheduling(first.pool).schedule(token, randomUUID(), snapshot);
  await first.held;
  const b = scheduling(second.pool).schedule(token, randomUUID(), snapshot);
  try {
    await observedWait(first.pid, second.pid);
  } finally {
    first.release();
  }
  expect((await a).kind).toBe("ready");
  expect(await b).toEqual({ kind: "unavailable" });
  for (const table of [
    "private_event_inventory",
    "private_event_rehearsals",
    "private_event_rehearsal_operations",
  ])
    expect(
      (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n,
    ).toBe(20);
});
it.each([false, true])(
  "REHSCHED-06 observed same-key competition recovers exactly one schedule, first rollback=%s",
  async (rollback) => {
    const token = await administrator(),
      snapshot = checked(),
      key = randomUUID();
    const first = instrument("INSERT INTO private_event_rehearsals", rollback),
      second = instrument();
    const a = scheduling(first.pool).schedule(token, key, snapshot);
    await first.held;
    const b = scheduling(second.pool).schedule(token, key, snapshot);
    try {
      await observedWait(first.pid, second.pid);
    } finally {
      first.release();
    }
    const resultA = await a,
      resultB = await b;
    expect(resultA.kind).toBe(rollback ? "unavailable" : "ready");
    expect(resultB.kind).toBe("ready");
    if (resultB.kind !== "ready") throw Error("Missing invented recovery");
    expect(resultB.value.replayed).toBe(!rollback);
    if (resultA.kind === "ready")
      expect(resultA.value.receipt).toEqual(resultB.value.receipt);
    for (const table of [
      "private_event_inventory",
      "private_event_rehearsals",
      "private_event_rehearsal_operations",
    ])
      expect(
        (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0]
          .n,
      ).toBe(1);
  },
);
it.each(["revoked", "token-replaced", "role-changed"])(
  "REHSCHED-05 %s wins the observed authority lock and prevents scheduling",
  async (change) => {
    const token = await administrator(),
      actor = (
        await pool.query("SELECT id FROM principals WHERE token_hash=$1", [
          hash(token),
        ])
      ).rows[0].id;
    const holder = await pool.connect(),
      waiting = instrument(),
      pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    try {
      await holder.query("BEGIN");
      await holder.query(
        change === "role-changed"
          ? "SELECT principal_id FROM staff_profiles WHERE principal_id=$1 FOR UPDATE"
          : "SELECT id FROM principals WHERE id=$1 FOR UPDATE",
        [actor],
      );
      const pending = scheduling(waiting.pool).schedule(
        token,
        randomUUID(),
        checked(),
      );
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
        (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
      ).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  },
);
it.each(["revoked", "role-changed"])(
  "REHSCHED-05 scheduling wins authority lock before %s and later replay is denied",
  async (change) => {
    const token = await administrator(),
      snapshot = checked(),
      key = randomUUID(),
      first = instrument("INSERT INTO private_event_rehearsals");
    const pending = scheduling(first.pool).schedule(token, key, snapshot);
    await first.held;
    const updater = await pool.connect(),
      pid = (await updater.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    try {
      const changed = updater.query(
        change === "revoked"
          ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE token_hash=$1"
          : "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=(SELECT id FROM principals WHERE token_hash=$1)",
        [hash(token)],
      );
      try {
        await observedWait(first.pid, () => pid);
      } finally {
        first.release();
      }
      expect((await pending).kind).toBe("ready");
      await changed;
      expect(await scheduling().schedule(token, key, snapshot)).toEqual({
        kind: "denied",
      });
      expect(
        (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
      ).toHaveLength(1);
    } finally {
      first.release();
      updater.release();
    }
  },
);
it("REHSCHED-05 authority expiry during an observed admission lock wait denies a late schedule", async () => {
  const token = await administrator();
  const expiry = (
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1 RETURNING expires_at",
      [hash(token)],
    )
  ).rows[0].expires_at as Date;
  const holder = await pool.connect(),
    waiting = instrument(),
    pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM private_event_rehearsal_admission WHERE id=1 FOR UPDATE",
    );
    const pending = scheduling(waiting.pool).schedule(
      token,
      randomUUID(),
      checked(),
    );
    await observedWait(() => pid, waiting.pid);
    const until = performance.now() + 3000;
    let expired = false;
    while (performance.now() < until) {
      expired = (
        await pool.query("SELECT clock_timestamp()>$1::timestamptz expired", [
          expiry,
        ])
      ).rows[0].expired;
      if (expired) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(expired).toBe(true);
    await holder.query("COMMIT");
    expect(await pending).toEqual({ kind: "denied" });
    expect(
      (await pool.query("SELECT id FROM private_event_rehearsals")).rows,
    ).toEqual([]);
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
});

it.each(["REPEATABLE READ", "SERIALIZABLE"] as const)(
  "REHSCHED-04 stale %s admission snapshot cannot overfill the last place",
  async (isolation) => {
    const token = await administrator(),
      snapshot = checked();
    for (let i = 0; i < 19; i++)
      expect(
        (await scheduling().schedule(token, randomUUID(), snapshot)).kind,
      ).toBe("ready");
    const first = instrument("INSERT INTO private_event_rehearsals"),
      second = instrument(undefined, false, isolation);
    const winner = scheduling(first.pool).schedule(
      token,
      randomUUID(),
      snapshot,
    );
    await first.held;
    const stale = scheduling(second.pool).schedule(
      token,
      randomUUID(),
      snapshot,
    );
    try {
      await observedWait(first.pid, second.pid);
    } finally {
      first.release();
    }
    expect((await winner).kind).toBe("ready");
    expect(await stale).toEqual({ kind: "unavailable" });
    for (const table of [
      "private_event_inventory",
      "private_event_rehearsals",
      "private_event_rehearsal_operations",
    ])
      expect(
        (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0]
          .n,
      ).toBe(20);
  },
);
it("REHSCHED-04 an observed uncommitted inventory write crossing the two-minute margin cannot commit a late schedule", async () => {
  const token = await administrator(),
    snapshot = rehearsalSnapshot({
      templateId: "local-registration-rehearsal",
      templateVersion: 1,
      startsAt: new Date(Date.now() + 122000).toISOString(),
    })!;
  const holder = instrument("INSERT INTO private_event_inventory");
  const pending = scheduling(holder.pool).schedule(
    token,
    randomUUID(),
    snapshot,
  );
  try {
    await holder.held;
    expect(
      (
        await pool.query("SELECT state FROM pg_stat_activity WHERE pid=$1", [
          holder.pid(),
        ])
      ).rows[0].state,
    ).toBe("idle in transaction");
    expect(await pending).toEqual({ kind: "denied" });
    expect(
      (
        await pool.query(
          "SELECT clock_timestamp()>=$1::timestamptz-interval '2 minutes' crossed",
          [snapshot.startsAt],
        )
      ).rows[0].crossed,
    ).toBe(true);
  } finally {
    holder.release();
  }
  for (const table of [
    "private_event_inventory",
    "private_event_rehearsals",
    "private_event_rehearsal_operations",
  ])
    expect(
      (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n,
    ).toBe(0);
}, 15000);
