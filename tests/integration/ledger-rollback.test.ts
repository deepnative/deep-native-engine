import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { LedgerFailure, syntheticLedger } from "../../src/ledger.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const observer = testPool();
const window = {
  startsAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
};
beforeAll(async () => migrate(observer));
beforeEach(async () => {
  await observer.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => observer.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  const db = store(observer);
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  return session.learner.id;
}

function failingLedger(
  pool: Pool,
  failRollback: boolean,
  serverRejects = false,
) {
  let pid = 0;
  const ledger = syntheticLedger({
    connect: async () => {
      const client = await pool.connect();
      pid = (
        await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      return {
        query: async (sql: string, args?: unknown[]) => {
          if (sql.includes("INSERT INTO synthetic_entitlement_events")) {
            if (serverRejects) {
              // Reject the real INSERT through the operation CHECK constraint,
              // leaving PostgreSQL's transaction aborted instead of still open.
              const invalidEvent = [...args!];
              invalidEvent[4] = "synthetic-invalid-operation";
              return client.query(sql, invalidEvent);
            }
            throw new Error("synthetic-private-event-delivery-marker");
          }
          if (failRollback && sql === "ROLLBACK")
            throw new Error("synthetic-private-rollback-delivery-marker");
          return client.query(sql, args);
        },
        release: (broken?: Error | boolean) => client.release(broken),
      };
    },
  } as unknown as Pool);
  return { ledger, pid: () => pid };
}

async function transactionState(pid: number) {
  const transaction = (
    await observer.query<{ open: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND xact_start IS NOT NULL) AS open",
      [pid],
    )
  ).rows[0]!.open;
  const locks = (
    await observer.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM pg_locks WHERE pid=$1 AND locktype='advisory'",
      [pid],
    )
  ).rows[0]!.count;
  return { transaction, locks };
}

it.each([
  { failRollback: true, serverRejects: false },
  { failRollback: false, serverRejects: false },
  { failRollback: true, serverRejects: true },
  { failRollback: false, serverRejects: true },
])(
  "leaves no grant without an event (rollback fails: $failRollback, server rejects: $serverRejects)",
  async ({ failRollback, serverRejects }) => {
    const owner = await member();
    // One physical connection makes reuse observable. Only query delivery is
    // injected; BEGIN, grant writes, locks and recovery use real PostgreSQL.
    const pool = new Pool({ ...observer.options, max: 1 });
    const failing = failingLedger(pool, failRollback, serverRejects);
    try {
      await expect(
        failing.ledger.grant(owner, "coach_minutes", 4, "failed-grant", window),
      ).rejects.toEqual(new LedgerFailure("unavailable"));

      const next = await pool.connect();
      let nextPid: number;
      let visibleGrants: number;
      try {
        const row = (
          await next.query<{ pid: number; count: number }>(
            "SELECT pg_backend_pid() AS pid, count(*)::integer AS count FROM synthetic_entitlement_grants WHERE member_id=$1",
            [owner],
          )
        ).rows[0]!;
        nextPid = row.pid;
        visibleGrants = row.count;
      } finally {
        next.release();
      }
      const state = await transactionState(failing.pid());

      const recovered = syntheticLedger(pool);
      const retried = await recovered.grant(
        owner,
        "coach_minutes",
        4,
        "failed-grant",
        window,
      );
      expect(
        await recovered.grant(
          owner,
          "coach_minutes",
          4,
          "failed-grant",
          window,
        ),
      ).toBe(retried);
      await recovered.grant(owner, "review_minutes", 2, "next-grant", window);
      const committed = (
        await observer.query<{
          grants: number;
          events: number;
          orphaned: number;
        }>(
          `SELECT count(*)::integer AS grants, count(e.id)::integer AS events,
            count(*) FILTER(WHERE e.id IS NULL)::integer AS orphaned
           FROM synthetic_entitlement_grants g
           LEFT JOIN synthetic_entitlement_events e ON e.grant_id=g.id AND e.operation='grant'
           WHERE g.member_id=$1`,
          [owner],
        )
      ).rows[0]!;
      expect({
        reused: nextPid === failing.pid(),
        visibleGrants,
        ...state,
        ...committed,
      }).toEqual({
        reused: !failRollback,
        visibleGrants: 0,
        transaction: false,
        locks: 0,
        grants: 2,
        events: 2,
        orphaned: 0,
      });
    } finally {
      await pool.end();
    }
  },
);

it.each([true, false])(
  "restores balances and leaves no reservation without an event (rollback fails: %s)",
  async (failRollback) => {
    const owner = await member();
    const grant = await syntheticLedger(observer).grant(
      owner,
      "coach_minutes",
      4,
      "reservation-grant",
      window,
    );
    const pool = new Pool({ ...observer.options, max: 1 });
    const failing = failingLedger(pool, failRollback);
    try {
      await expect(
        failing.ledger.reserve(owner, grant, 2, "failed-reservation"),
      ).rejects.toEqual(new LedgerFailure("unavailable"));
      const next = await pool.connect();
      let nextPid: number;
      let balance: {
        available: number;
        reserved: number;
        reservations: number;
      };
      try {
        nextPid = (
          await next.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        balance = (
          await next.query<{
            available: number;
            reserved: number;
            reservations: number;
          }>(
            `SELECT available,reserved,
              (SELECT count(*)::integer FROM synthetic_entitlement_reservations WHERE grant_id=g.id) AS reservations
             FROM synthetic_entitlement_grants g WHERE g.id=$1`,
            [grant],
          )
        ).rows[0]!;
      } finally {
        next.release();
      }
      expect({
        reused: nextPid === failing.pid(),
        ...balance,
        ...(await transactionState(failing.pid())),
      }).toEqual({
        reused: !failRollback,
        available: 4,
        reserved: 0,
        reservations: 0,
        transaction: false,
        locks: 0,
      });

      const recovered = syntheticLedger(pool);
      const retried = await recovered.reserve(
        owner,
        grant,
        2,
        "failed-reservation",
      );
      expect(
        await recovered.reserve(owner, grant, 2, "failed-reservation"),
      ).toBe(retried);
      await recovered.reserve(owner, grant, 1, "next-reservation");
      expect(
        (
          await observer.query(
            "SELECT available,reserved,consumed,expired,adjusted FROM synthetic_entitlement_grants WHERE id=$1",
            [grant],
          )
        ).rows,
      ).toEqual([
        { available: 1, reserved: 3, consumed: 0, expired: 0, adjusted: 0 },
      ]);
      expect(
        (
          await observer.query(
            `SELECT count(*)::integer AS reservations, count(e.id)::integer AS events,
              count(*) FILTER(WHERE e.id IS NULL)::integer AS orphaned
             FROM synthetic_entitlement_reservations r
             LEFT JOIN synthetic_entitlement_events e ON e.reservation_id=r.id AND e.operation='reserve'
             WHERE r.grant_id=$1`,
            [grant],
          )
        ).rows,
      ).toEqual([{ reservations: 2, events: 2, orphaned: 0 }]);
    } finally {
      await pool.end();
    }
  },
);
