import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Pool } from "pg";
import { memberExportStore } from "../../src/member-export.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, wait };
}
async function fixture() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "technical", goal: "build" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  const id = session.learner.id,
    ledger = syntheticLedger(pool);
  const grant = await ledger.grant(id, "study_requests", 2, randomUUID(), {
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const hold = await ledger.reserve(id, grant, 1, randomUUID());
  await ledger.settleCompletion(id, hold, randomUUID(), {
    reference: "synthetic:race-" + randomUUID(),
    category: "study_requests",
    quantity: 1,
  });
  return { id, token };
}
async function blocked(pid: number, blocker: number) {
  const end = performance.now() + 2500;
  while (performance.now() < end) {
    if (
      (
        await pool.query(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked",
          [blocker, pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected PostgreSQL lock conflict not observed");
}
function controlled(paused: boolean) {
  const entered = gate(),
    resume = gate(),
    connected = gate();
  let pid = 0;
  const wrapper = {
    connect: async () => {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      connected.release();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (paused && sql.includes("FROM synthetic_entitlement_events e")) {
            entered.release();
            await resume.wait;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  return {
    exporter: memberExportStore(wrapper),
    entered,
    resume,
    connected,
    pid: () => pid,
  };
}
const mutate = (action: string) =>
  action === "revocation"
    ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
    : "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1";
it.each(["revocation", "workspace erasure"])(
  "withholds every retained history section when %s wins the lock",
  async (action) => {
    const own = await fixture(),
      other = await fixture(),
      writer = await pool.connect(),
      read = controlled(false);
    let reading: ReturnType<typeof read.exporter.exportOwned> | undefined;
    try {
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      await writer.query("BEGIN");
      await writer.query(mutate(action), [own.id]);
      reading = read.exporter.exportOwned(own.token);
      await read.connected.wait;
      await blocked(read.pid(), writerPid);
      expect(
        (await memberExportStore(pool).exportOwned(other.token)).kind,
      ).toBe("ready");
      await writer.query("COMMIT");
      const value = await reading;
      expect(value).toEqual({ kind: "unavailable" });
      expect((await memberExportStore(pool).exportOwned(own.token)).kind).toBe(
        "denied",
      );
    } finally {
      await writer.query("ROLLBACK");
      await Promise.allSettled(reading ? [reading] : []);
      writer.release();
    }
  },
);
it.each(["revocation", "workspace erasure"])(
  "finishes the owned history page before a conflicting %s can commit",
  async (action) => {
    const own = await fixture(),
      writer = await pool.connect(),
      read = controlled(true);
    const reading = read.exporter.exportOwned(own.token);
    let changing: Promise<unknown> | undefined;
    try {
      await read.entered.wait;
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      await writer.query("BEGIN");
      changing = writer.query(mutate(action), [own.id]);
      await blocked(writerPid, read.pid());
      read.resume.release();
      const value = await reading;
      expect(value.kind).toBe("ready");
      if (value.kind !== "ready") throw Error("Private export unavailable");
      expect(value.payload.records.testUnitGrants).toHaveLength(1);
      expect(value.payload.records.testUnitReservations).toHaveLength(1);
      expect(value.payload.records.testUnitEvents).toHaveLength(3);
      expect(value.payload.records.testUnitSettlements).toHaveLength(1);
      await changing;
      await writer.query("COMMIT");
      expect((await memberExportStore(pool).exportOwned(own.token)).kind).toBe(
        "denied",
      );
    } finally {
      read.resume.release();
      await Promise.allSettled([reading, ...(changing ? [changing] : [])]);
      await writer.query("ROLLBACK");
      writer.release();
    }
  },
);
it("discards a real PostgreSQL connection on a withheld COMMIT reply, returning no history and releasing authorization locks", async () => {
  const own = await fixture(),
    calls: string[] = [];
  const wrapper = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          calls.push(sql);
          if (sql === "COMMIT") return new Promise(() => {});
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  const started = performance.now();
  expect(await memberExportStore(wrapper).exportOwned(own.token)).toEqual({
    kind: "unavailable",
  });
  expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
  expect(performance.now() - started).toBeLessThan(10000);
  expect(calls).not.toContain("ROLLBACK");
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout='1s'");
    await writer.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
      own.id,
    ]);
    await writer.query(
      "SELECT id FROM workspaces WHERE owner_principal_id=$1 FOR UPDATE",
      [own.id],
    );
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
  expect((await memberExportStore(pool).exportOwned(own.token)).kind).toBe(
    "ready",
  );
}, 15000);
