import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import type { Pool } from "pg";
import { migrate } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { eventRehearsalStore } from "../../src/event-rehearsals.ts";
import { rehearsalSnapshot } from "../../src/event-rehearsal-values.ts";
import { testPool } from "../support/database.ts";
const pool = testPool();
const scheduling = (db = pool) =>
  eventRehearsalStore(db, { mode: "test", writes: true, registration: true });
beforeAll(() => migrate(pool));
beforeEach(() =>
  pool.query("TRUNCATE principals,private_event_inventory CASCADE"),
);
afterAll(() => pool.end());
async function fixture(margin = 3600000) {
  const token = randomBytes(32).toString("hex"),
    key = randomUUID();
  await authorizationStore(pool).provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 3600000),
  );
  const checked = rehearsalSnapshot({
    templateId: "local-registration-rehearsal",
    templateVersion: 1,
    startsAt: new Date(Date.now() + margin).toISOString(),
  })!;
  return { token, key, checked };
}
async function empty() {
  for (const table of [
    "private_event_inventory",
    "private_event_rehearsals",
    "private_event_rehearsal_operations",
  ])
    expect(
      (await pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n,
    ).toBe(0);
}
it("REHSCHED-06 late real connection acquisition is bounded and releases the unaccepted connection without writing", async () => {
  const f = await fixture();
  let proceed!: () => void,
    released = 0,
    acquisitions = 0;
  const held = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const scoped = {
    connect: async () => {
      acquisitions++;
      const client = await pool.connect();
      await held;
      return new Proxy(client, {
        get(target, property) {
          if (property === "release")
            return (error?: Error) => {
              released++;
              target.release(error);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
  const entered = performance.now();
  try {
    expect(
      await scheduling(scoped).schedule(f.token, f.key, f.checked),
    ).toEqual({ kind: "unavailable" });
    expect(performance.now() - entered).toBeLessThan(5000);
  } finally {
    proceed();
  }
  const until = performance.now() + 3000;
  while (!released && performance.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(released).toBe(1);
  expect(acquisitions).toBe(1);
  await empty();
}, 15000);
it("REHSCHED-06 actual PostgreSQL query stall ends within the existing bound without scheduling or retry", async () => {
  const f = await fixture();
  let acquisitions = 0,
    stalled = 0;
  const scoped = {
    connect: async () => {
      acquisitions++;
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              if (sql.includes("FROM principals")) {
                stalled++;
                await target.query("SELECT pg_sleep(6)");
              }
              return target.query(sql, values);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
  const entered = performance.now();
  expect(await scheduling(scoped).schedule(f.token, f.key, f.checked)).toEqual({
    kind: "unavailable",
  });
  expect(performance.now() - entered).toBeLessThan(8000);
  expect(acquisitions).toBe(1);
  expect(stalled).toBe(1);
  await empty();
}, 15000);
it("REHSCHED-04/06 actual COMMIT with acknowledgment held across the two-minute boundary is uncertain and manually recovers one event", async () => {
  const f = await fixture(122000);
  let allow!: () => void,
    committed!: () => void,
    commits = 0,
    rollbacks = 0;
  const held = new Promise<void>((resolve) => {
      allow = resolve;
    }),
    observed = new Promise<void>((resolve) => {
      committed = resolve;
    });
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              if (sql === "ROLLBACK") rollbacks++;
              const result = await target.query(sql, values);
              if (sql === "COMMIT") {
                commits++;
                committed();
                await held;
              }
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
  const result = scheduling(scoped).schedule(f.token, f.key, f.checked);
  try {
    await observed;
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM private_event_rehearsals",
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await result).toEqual({ kind: "unavailable" });
  } finally {
    allow();
  }
  expect(commits).toBe(1);
  expect(rollbacks).toBe(0);
  expect(
    await scheduling().inspectOperation(f.token, f.key, f.checked),
  ).toMatchObject({ kind: "ready", value: { eventVersion: 1 } });
  expect(await scheduling().schedule(f.token, f.key, f.checked)).toMatchObject({
    kind: "ready",
    value: { replayed: true },
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_rehearsals",
      )
    ).rows[0].n,
  ).toBe(1);
}, 15000);
it("REHSCHED-06 native release failure withholds success after actual COMMIT and retains the original operation for manual recovery", async () => {
  const f = await fixture();
  let releases = 0;
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "release")
            return (error?: Error) => {
              releases++;
              target.release(error);
              throw Error("Invented native release failure");
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pool;
  expect(await scheduling(scoped).schedule(f.token, f.key, f.checked)).toEqual({
    kind: "unavailable",
  });
  expect(releases).toBe(1);
  expect(await scheduling().schedule(f.token, f.key, f.checked)).toMatchObject({
    kind: "ready",
    value: { replayed: true },
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM private_event_rehearsals",
      )
    ).rows[0].n,
  ).toBe(1);
});
