import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { circleGrantAdminStore } from "../../src/circle-grant-admin.ts";
import type { CircleGrantResult } from "../../src/circle-grant-values.ts";
import { migrate } from "../../src/store.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  auth = authorizationStore(pool),
  circle = "everyday-ai";
const subject = (source = pool) =>
  circleGrantAdminStore(source, "invented-lifetime", {
    mode: "test",
    writes: true,
    discussion: true,
  });
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());
function value<T>(result: CircleGrantResult<T>) {
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Missing invented current result");
  return result.value;
}
async function fixture() {
  const admin = randomBytes(32).toString("hex"),
    target = randomBytes(32).toString("hex"),
    expires = new Date(Date.now() + 3600000);
  const adminId = await auth.provisionStaff(admin, "platform_admin", expires),
    staffId = await auth.provisionStaff(target, "moderator", expires);
  return {
    admin,
    target,
    adminId,
    staffId,
    scope: { staffId, circleId: circle },
    input: {
      staffId,
      circleId: circle,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 1800000),
    },
  };
}
async function afterExpiry(expires: Date) {
  await pool.query(
    "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)",
    [expires],
  );
}
async function counts(staffId: string) {
  return (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM preview_circle_moderator_grants WHERE staff_id=$1) grants,(SELECT count(*)::int FROM preview_circle_grant_audit WHERE staff_id=$1 AND action='created') created,(SELECT count(*)::int FROM preview_circle_grant_audit WHERE staff_id=$1 AND action='revoked') revoked",
      [staffId],
    )
  ).rows[0];
}
it.each(["before", "after", "release"] as const)(
  "CIRADM-04/05 %s-COMMIT failure preserves one exact creator-key recovery without retry or compensation",
  async (phase) => {
    const f = await fixture(),
      statements: string[] = [];
    let releases = 0;
    const proxy = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            statements.push(sql);
            if (sql === "COMMIT" && phase === "before")
              throw Error("PRIVATE-COMMIT-FAULT");
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && phase === "after")
              throw Error("PRIVATE-COMMIT-ACK");
            return result;
          }) as PoolClient["query"],
          release: (error?: Error) => {
            releases++;
            client.release(error);
            if (phase === "release") throw Error("PRIVATE-RELEASE");
          },
        };
      },
    } as unknown as Pool;
    expect(await subject(proxy).create(f.admin, f.input)).toEqual({
      kind: "unavailable",
    });
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
    expect(releases).toBe(1);
    const inspected = value(
      await subject().inspect(f.admin, f.scope, {
        kind: "key",
        value: f.input.idempotencyKey,
      }),
    );
    if (phase === "before") expect(inspected).toBeNull();
    else
      expect(inspected).toMatchObject({
        source: "retained",
        state: "current",
        expiresAt: f.input.expiresAt,
      });
    expect(await counts(f.staffId)).toEqual({
      grants: phase === "before" ? 0 : 1,
      created: phase === "before" ? 0 : 1,
      revoked: 0,
    });
    const manual = value(await subject().create(f.admin, f.input));
    if (inspected) expect(manual).toEqual(inspected);
    expect(await counts(f.staffId)).toEqual({
      grants: 1,
      created: 1,
      revoked: 0,
    });
  },
);
it.each(["audit", "rollback"] as const)(
  "CIRADM-04 %s failure leaves neither an unaudited grant nor a retry",
  async (phase) => {
    const f = await fixture(),
      statements: string[] = [];
    const proxy = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            statements.push(sql);
            if (
              sql.startsWith("INSERT INTO preview_circle_grant_audit") ||
              (sql === "ROLLBACK" && phase === "rollback")
            )
              throw Error("PRIVATE-AUDIT-FAULT");
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    expect(await subject(proxy).create(f.admin, f.input)).toEqual({
      kind: "unavailable",
    });
    expect(
      statements.filter((s) =>
        s.startsWith("INSERT INTO preview_circle_moderator_grants"),
      ),
    ).toHaveLength(1);
    expect(statements).not.toContain("COMMIT");
    expect(await counts(f.staffId)).toEqual({
      grants: 0,
      created: 0,
      revoked: 0,
    });
    expect(
      value(
        await subject().inspect(f.admin, f.scope, {
          kind: "key",
          value: f.input.idempotencyKey,
        }),
      ),
    ).toBeNull();
  },
);
const lifetimeCases = (["actor", "target"] as const).flatMap((authority) =>
  (["observation", "commit", "release"] as const).map((phase) => ({
    authority,
    phase,
  })),
);
it.each(lifetimeCases)(
  "CIRADM-05 actual $authority expiry through $phase rejects native acceptance and preserves current-admin structural recovery",
  async ({ authority, phase }) => {
    const f = await fixture(),
      expires = new Date(Date.now() + 1400),
      pending: Promise<unknown>[] = [];
    await pool.query("UPDATE principals SET expires_at=$1 WHERE id=$2", [
      expires,
      authority === "actor" ? f.adminId : f.staffId,
    ]);
    if (authority === "target") f.input.expiresAt = expires;
    let commits = 0,
      observations = 0,
      releases = 0;
    const proxy = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql.startsWith("WITH instant")) {
              observations++;
              if (
                phase === "observation" &&
                observations === (authority === "actor" ? 1 : 2)
              ) {
                const wait = afterExpiry(expires);
                pending.push(wait);
                await wait;
              }
            }
            if (sql === "COMMIT") {
              commits++;
              if (phase === "commit") {
                const wait = afterExpiry(expires);
                pending.push(wait);
                await wait;
              }
            }
            return result;
          }) as PoolClient["query"],
          release: (error?: Error) => {
            releases++;
            if (phase === "release")
              while (Date.now() <= +expires + 20) {
                /* Actual synchronous native handback. */
              }
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const result = await subject(proxy).create(f.admin, f.input);
    await Promise.all(pending);
    expect(result).toEqual({
      kind: phase === "observation" ? "denied" : "unavailable",
    });
    expect(commits).toBe(phase === "observation" ? 0 : 1);
    expect(releases).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
          [authority === "actor" ? f.adminId : f.staffId],
        )
      ).rows[0].expired,
    ).toBe(true);
    let reader = f.admin;
    if (authority === "actor") {
      reader = randomBytes(32).toString("hex");
      await auth.provisionStaff(
        reader,
        "platform_admin",
        new Date(Date.now() + 60000),
      );
      expect((await subject().history(f.admin, f.scope)).kind).toBe("denied");
    }
    const history = value(await subject().history(reader, f.scope));
    expect(history.items).toHaveLength(phase === "observation" ? 0 : 1);
    expect(await counts(f.staffId)).toEqual({
      grants: phase === "observation" ? 0 : 1,
      created: phase === "observation" ? 0 : 1,
      revoked: 0,
    });
    if (history.items[0]) {
      const exact = value(
        await subject().revoke(reader, f.scope, history.items[0].grantId),
      );
      expect(exact).toMatchObject({ state: "revoked" });
      if (authority === "target")
        expect(
          value(
            await subject().inspect(reader, f.scope, {
              kind: "key",
              value: f.input.idempotencyKey,
            }),
          ),
        ).toEqual(exact);
    }
  },
  10000,
);
it("CIRADM-05 retains the earliest charged database observation through later observations and native handback", async () => {
  const f = await fixture(),
    expires = new Date(Date.now() + 2600),
    statements: string[] = [];
  await pool.query("UPDATE principals SET expires_at=$1 WHERE id=$2", [
    expires,
    f.adminId,
  ]);
  let first = true,
    earlyDeadline = Infinity,
    firstEntered = Infinity,
    committed = false;
  const proxy = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          const result = await client.query(sql, values);
          if (sql.startsWith("WITH instant") && first) {
            first = false;
            // Delay the actual SQL execution's acknowledgement. A later observation
            // is fresher but must never extend the first conservative deadline.
            await pool.query("SELECT pg_sleep(0.9)");
            earlyDeadline = firstEntered + Number(result.rows[0].remaining);
          }
          if (sql === "COMMIT") committed = true;
          return result;
        }) as PoolClient["query"],
        release: (error?: Error) => {
          if (committed)
            while (performance.now() <= earlyDeadline + 20) {
              /* Native handback crosses retained earliest deadline. */
            }
          client.release(error);
        },
      };
    },
  } as unknown as Pool;
  // The pre-query elapsed time is charged, so this first SQL observation is
  // made to observe a later clock while the call's monotonic entry stays early.
  const delayed = {
    connect: async () => {
      const client = await proxy.connect();
      let initial = true;
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.startsWith("WITH instant") && initial) {
            initial = false;
            firstEntered = performance.now();
            await pool.query("SELECT pg_sleep(0.5)");
          }
          return client.query(sql, values);
        }) as PoolClient["query"],
        release: client.release.bind(client),
      };
    },
  } as unknown as Pool;
  expect(await subject(delayed).create(f.admin, f.input)).toEqual({
    kind: "unavailable",
  });
  expect(committed).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT expires_at>clock_timestamp() current FROM principals WHERE id=$1",
        [f.adminId],
      )
    ).rows[0].current,
  ).toBe(true);
  expect(
    statements.filter((sql) => sql.startsWith("WITH instant")).length,
  ).toBeGreaterThan(1);
  expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
  expect(statements).not.toContain("ROLLBACK");
  expect(await counts(f.staffId)).toEqual({
    grants: 1,
    created: 1,
    revoked: 0,
  });
});

it.each(["inspect", "history", "revoke"] as const)(
  "CIRADM-05 historical %s carries only the current actor deadline through actual target expiry at COMMIT",
  async (operation) => {
    const f = await fixture(),
      created = value(await subject().create(f.admin, f.input)),
      expires = new Date(Date.now() + 1000),
      pending: Promise<unknown>[] = [];
    await pool.query("UPDATE principals SET expires_at=$1 WHERE id=$2", [
      expires,
      f.staffId,
    ]);
    let commits = 0;
    const proxy = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            const result = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              const wait = afterExpiry(expires);
              pending.push(wait);
              await wait;
            }
            return result;
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    const backend = subject(proxy),
      result =
        operation === "inspect"
          ? await backend.inspect(f.admin, f.scope, {
              kind: "key",
              value: f.input.idempotencyKey,
            })
          : operation === "history"
            ? await backend.history(f.admin, f.scope)
            : await backend.revoke(f.admin, f.scope, created.grantId);
    await Promise.all(pending);
    expect(result.kind).toBe("ready");
    expect(commits).toBe(1);
    if (result.kind === "ready")
      expect(result.deadline).toBeGreaterThan(performance.now());
    expect(
      (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() expired FROM principals WHERE id=$1",
          [f.staffId],
        )
      ).rows[0].expired,
    ).toBe(true);
    expect(
      value(
        await subject().inspect(f.admin, f.scope, {
          kind: "grant",
          value: created.grantId,
        }),
      ),
    ).toMatchObject({
      state: operation === "revoke" ? "revoked" : "ineffective",
    });
    expect((await subject().check(f.admin, f.staffId, circle)).kind).toBe(
      "denied",
    );
    expect(await counts(f.staffId)).toEqual({
      grants: 1,
      created: 1,
      revoked: operation === "revoke" ? 1 : 0,
    });
  },
  10000,
);
