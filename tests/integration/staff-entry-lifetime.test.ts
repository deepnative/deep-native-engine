import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { app } from "../../src/app.ts";
import { withLoopback } from "../support/loopback-server.ts";
import { entryNonce, entryCsrf } from "../../src/staff-entry-integrity.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import {
  staffEntryStore,
  type StaffEntryResult,
} from "../../src/staff-entry.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  auth = authorizationStore(pool);
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());
async function fixture() {
  const token = randomBytes(32).toString("hex"),
    id = await auth.provisionStaff(
      token,
      "operator",
      new Date(Date.now() + 3600000),
    );
  return { token, id };
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { release, wait };
}
async function blockedBy(pid: number) {
  for (let n = 0; n < 200; n++) {
    if (
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          [pid],
        )
      ).rowCount
    )
      return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Expected actual PostgreSQL lock wait");
}
const changes = {
  revoked: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
  expired:
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
  profile: "DELETE FROM staff_profiles WHERE principal_id=$1",
};
it.each(Object.keys(changes) as (keyof typeof changes)[])(
  "STAFF-06-REVOCATION update-first %s denies admission after an observed native lock wait",
  async (kind) => {
    const f = await fixture(),
      holder = await pool.connect();
    let pending: Promise<StaffEntryResult> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid as number;
      await holder.query(changes[kind], [f.id]);
      pending = staffEntryStore(pool).admit(f.token);
      await blockedBy(pid);
      await holder.query("COMMIT");
      expect(await pending).toEqual({ kind: "denied" });
      expect(await staffEntryStore(pool).admit(f.token)).toEqual({
        kind: "denied",
      });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await Promise.allSettled(pending ? [pending] : []);
    }
  },
);
it.each(Object.keys(changes) as (keyof typeof changes)[])(
  "STAFF-06-REVOCATION admission-first %s linearizes before the change then fresh access denies",
  async (kind) => {
    const f = await fixture(),
      entered = gate(),
      resume = gate();
    let pid = 0,
      changing: Promise<unknown> | undefined;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid;
        return {
          query: (async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.startsWith("SELECT EXTRACT")) {
              entered.release();
              await resume.wait;
            }
            return result;
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const pending = staffEntryStore(scoped).admit(f.token);
    try {
      await Promise.race([
        entered.wait,
        pending.then(() => {
          throw Error("Admission completed before fence");
        }),
      ]);
      changing = pool.query(changes[kind], [f.id]);
      await blockedBy(pid);
      resume.release();
      expect(await pending).toMatchObject({ kind: "ready", role: "operator" });
      await changing;
      expect(await staffEntryStore(pool).admit(f.token)).toEqual({
        kind: "denied",
      });
    } finally {
      resume.release();
      await Promise.allSettled([pending, ...(changing ? [changing] : [])]);
    }
  },
);
it.each(["selection", "commit", "release"])(
  "STAFF-06-EXPIRY withholds finite admission after delayed native %s",
  async (phase) => {
    const f = await fixture(),
      late = gate();
    await pool.query(
      "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
      [f.id],
    );
    let released = false;
    const sqls: string[] = [];
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            sqls.push(sql);
            const result = await client.query(sql, values);
            if (
              (phase === "selection" && sql.startsWith("SELECT id,expires")) ||
              (phase === "commit" && sql === "COMMIT")
            ) {
              try {
                await pool.query(
                  "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.1) FROM principals WHERE id=$1",
                  [f.id],
                );
              } finally {
                late.release();
              }
            }
            return result;
          }) as PoolClient["query"],
          release: (error?: Error | boolean) => {
            client.release(error);
            released = true;
            if (phase === "release")
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                1150,
              );
          },
        };
      },
    } as unknown as Pool;
    expect(await staffEntryStore(scoped).admit(f.token)).toEqual({
      kind: "denied",
    });
    if (phase !== "release") await late.wait;
    expect(released).toBe(true);
    expect(sqls.filter((s) => s === "COMMIT").length).toBeLessThanOrEqual(1);
    if (phase === "commit") expect(sqls).not.toContain("ROLLBACK");
  },
);
it("STAFF-06-FAULTS bounds real native acquisition and safely discards its late handback", async () => {
  const f = await fixture(),
    single = new Pool({
      connectionString: process.env.DNE_TEST_DATABASE_URL,
      max: 1,
    }),
    held = await single.connect();
  try {
    expect(await staffEntryStore(single).admit(f.token)).toEqual({
      kind: "unavailable",
    });
    held.release();
    await new Promise<void>((resolve) =>
      single.once("remove", () => resolve()),
    );
    expect(await staffEntryStore(single).admit(f.token)).toMatchObject({
      kind: "ready",
    });
  } finally {
    await single.end();
  }
}, 10000);
it("STAFF-06-FAULTS bounds a native principal lock wait and leaves no acquired transaction behind", async () => {
  const f = await fixture(),
    holder = await pool.connect();
  let pending: Promise<StaffEntryResult> | undefined,
    pid = 0;
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return client;
    },
  } as unknown as Pool;
  try {
    await holder.query("BEGIN");
    const blocker = (await holder.query("SELECT pg_backend_pid() AS pid"))
      .rows[0].pid as number;
    await holder.query(
      "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
      [f.id],
    );
    pending = staffEntryStore(scoped).admit(f.token);
    await blockedBy(blocker);
    expect(await pending).toEqual({ kind: "unavailable" });
    await holder.query("ROLLBACK");
    expect(
      (
        await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND xact_start IS NOT NULL",
          [pid],
        )
      ).rowCount,
    ).toBe(0);
    expect(await staffEntryStore(pool).admit(f.token)).toMatchObject({
      kind: "ready",
    });
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
    await Promise.allSettled(pending ? [pending] : []);
  }
}, 10000);
it.each(["BEGIN", "SELECT role", "COMMIT"])(
  "STAFF-06-FAULTS native %s error withholds output and a fresh request can recover",
  async (phase) => {
    const f = await fixture();
    let released = false;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            if (sql.startsWith(phase)) return client.query("SELECT 1/0");
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: (error?: Error | boolean) => {
            client.release(error);
            released = true;
          },
        };
      },
    } as unknown as Pool;
    expect(await staffEntryStore(scoped).admit(f.token)).toEqual({
      kind: "unavailable",
    });
    expect(released).toBe(true);
    expect(await staffEntryStore(pool).admit(f.token)).toMatchObject({
      kind: "ready",
    });
  },
);
it("STAFF-06-EXPIRY real admission completed before expiry is withheld after a delayed synchronous HTTP handoff", async () => {
  const f = await fixture(),
    secret = "synthetic-handoff",
    origin = "http://127.0.0.1:3000";
  const admitted: StaffEntryResult[] = [];
  const application = app(store(pool), {
    origin,
    secret,
    localStaffEntry: true,
    staffEntry: {
      admit: async (token) => {
        const result = await staffEntryStore(pool).admit(token);
        admitted.push(result);
        if (result.kind === "ready")
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            Math.max(0, result.deadline - performance.now()) + 100,
          );
        return result;
      },
    },
  });
  await withLoopback(application, async (server) => {
    for (const path of ["/staff/sign-in", "/staff"]) {
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [f.id],
      );
      const nonce = entryNonce(secret);
      const r = path.endsWith("sign-in")
        ? await request(server)
            .post(path)
            .set("Host", "127.0.0.1:3000")
            .set("Origin", origin)
            .set("Cookie", `dne_staff_entry=${nonce}`)
            .type("form")
            .send({ credential: f.token, csrf: entryCsrf(nonce, secret) })
        : await request(server)
            .get(path)
            .set("Host", "127.0.0.1:3000")
            .set("Cookie", `dne_staff=${f.token}`);
      expect(r.status).toBe(403);
      expect(r.text).not.toContain("Local operator");
      expect(r.text).not.toContain(f.token);
      expect(
        ((r.headers["set-cookie"] ?? []) as string[]).some((v) =>
          v.startsWith("dne_staff="),
        ),
      ).toBe(false);
    }
  });
  expect(admitted).toHaveLength(2);
  expect(admitted.every((r) => r.kind === "ready")).toBe(true);
}, 10000);
