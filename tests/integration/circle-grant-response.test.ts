import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { circleGrantAdminStore } from "../../src/circle-grant-admin.ts";
import type { CircleGrantAdminStore } from "../../src/circle-grant-values.ts";
import { migrate, store } from "../../src/store.ts";
import { csrf } from "../../src/session.ts";
import { testPool } from "../support/database.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  secret = "invented-http-boundary",
  origin = "http://127.0.0.1:3000",
  circleId = "everyday-ai",
  base = "/operator/circle-grants";
const subject = (source = pool) =>
  circleGrantAdminStore(source, secret, {
    mode: "test",
    writes: true,
    discussion: true,
  });
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());
async function fixture() {
  const admin = randomBytes(32).toString("hex"),
    target = randomBytes(32).toString("hex"),
    expiry = new Date(Date.now() + 3600000),
    adminId = await auth.provisionStaff(admin, "platform_admin", expiry),
    staffId = await auth.provisionStaff(target, "moderator", expiry);
  return {
    admin,
    adminId,
    staffId,
    input: {
      csrf: csrf(admin, secret),
      staffId,
      circleId,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      confirm: "yes",
    },
  };
}
function application(backend: CircleGrantAdminStore) {
  return app(members, {
    origin,
    secret,
    mode: "test",
    authorization: auth,
    localStaffEntry: true,
    circleDiscussionEnabled: true,
    ...{ circleGrantAdmin: backend, localCircleAdmin: true },
  });
}
const write = (
  server: Parameters<typeof request>[0],
  f: Awaited<ReturnType<typeof fixture>>,
) =>
  request(server)
    .post(`${base}/create`)
    .set("Host", new URL(origin).host)
    .set("Origin", origin)
    .set("Cookie", `dne_staff=${f.admin}`)
    .type("form")
    .send(f.input);
function protectedOriginal(
  html: string,
  input: Awaited<ReturnType<typeof fixture>>["input"],
) {
  for (const name of [
    "staffId",
    "circleId",
    "idempotencyKey",
    "expiresAt",
  ] as const)
    expect(html).toMatch(
      new RegExp(
        `name="${name}"[^>]*value="${input[name].replaceAll(".", "\\.")}"[^>]*readonly`,
      ),
    );
  expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  expect(html).toContain('target="_blank" rel="noopener"');
  expect(html).not.toMatch(
    new RegExp(`(?:href|action)="[^"]*${input.idempotencyKey}`),
  );
  expect(html).not.toContain("PRIVATE-TRANSPORT-DETAIL");
}
it.each(["before", "after", "release"] as const)(
  "CIRADM-04 actual HTTP %s COMMIT uncertainty preserves the protected original instruction and fresh inspection",
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
              throw Error("PRIVATE-TRANSPORT-DETAIL");
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && phase === "after")
              throw Error("PRIVATE-TRANSPORT-DETAIL");
            return result;
          }) as PoolClient["query"],
          release: (error?: Error) => {
            releases++;
            client.release(error);
            if (phase === "release") throw Error("PRIVATE-TRANSPORT-DETAIL");
          },
        };
      },
    } as unknown as Pool;
    const response = await withLoopback(application(subject(proxy)), (server) =>
      write(server, f),
    );
    expect(response.status).toBe(503);
    expect(response.headers.location).toBeUndefined();
    protectedOriginal(response.text, f.input);
    expect(releases).toBe(1);
    expect(statements.filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
    const inspect = await withLoopback(application(subject()), (server) =>
      request(server)
        .post(`${base}/inspect`)
        .set("Host", new URL(origin).host)
        .set("Origin", origin)
        .set("Cookie", `dne_staff=${f.admin}`)
        .type("form")
        .send({
          csrf: f.input.csrf,
          staffId: f.staffId,
          circleId,
          lookupKind: "key",
          lookupValue: f.input.idempotencyKey,
        }),
    );
    expect(inspect.status).toBe(200);
    if (phase === "before") {
      expect(inspect.text).toContain("does not prove");
      expect(inspect.text).not.toContain("data-circle-grant");
    } else {
      expect(inspect.text).toContain("data-circle-grant");
      expect(inspect.text).toContain(f.input.expiresAt);
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM preview_circle_grant_audit WHERE staff_id=$1 AND action='created'",
          [f.staffId],
        )
      ).rows[0].n,
    ).toBe(phase === "before" ? 0 : 1);
    const manual = await withLoopback(application(subject()), (server) =>
      write(server, f),
    );
    expect(manual.status).toBe(200);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM preview_circle_grant_audit WHERE staff_id=$1 AND action='created'",
          [f.staffId],
        )
      ).rows[0].n,
    ).toBe(1);
  },
);
it("CIRADM-05 HTTP write acceptance retains the native deadline after successful COMMIT and returns exact-key recovery instead of a late receipt", async () => {
  const f = await fixture();
  f.input.expiresAt = new Date(Date.now() + 1300).toISOString();
  const real = subject();
  let deadline: number | undefined,
    nativeReady = false;
  const backend: CircleGrantAdminStore = {
    ...real,
    async create(...args) {
      const result = await real.create(...args);
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") {
        nativeReady = true;
        deadline = result.deadline;
        await pool.query(
          "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)",
          [f.input.expiresAt],
        );
        expect(performance.now()).toBeGreaterThan(result.deadline);
      }
      return result;
    },
  };
  const response = await withLoopback(application(backend), (server) =>
    write(server, f),
  );
  expect(nativeReady).toBe(true);
  expect(deadline).toBeTypeOf("number");
  expect(response.status).toBe(503);
  protectedOriginal(response.text, f.input);
  expect(response.text).not.toContain("data-circle-grant");
  const inspected = await real.inspect(
    f.admin,
    { staffId: f.staffId, circleId },
    { kind: "key", value: f.input.idempotencyKey },
  );
  expect(inspected.kind).toBe("ready");
  if (inspected.kind === "ready")
    expect(inspected.value).toMatchObject({
      state: "expired",
      expiresAt: new Date(f.input.expiresAt),
    });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM preview_circle_grant_audit WHERE staff_id=$1",
        [f.staffId],
      )
    ).rows[0].n,
  ).toBe(1);
}, 10000);
it("CIRADM-05 HTTP reference acceptance withholds an actual native-ready result after the selected actor deadline", async () => {
  const f = await fixture(),
    expires = new Date(Date.now() + 1300);
  await pool.query("UPDATE principals SET expires_at=$1 WHERE id=$2", [
    expires,
    f.adminId,
  ]);
  const real = subject();
  let nativeReady = false;
  const backend: CircleGrantAdminStore = {
    ...real,
    async reference(...args) {
      const result = await real.reference(...args);
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") {
        nativeReady = true;
        await pool.query(
          "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)",
          [expires],
        );
        expect(performance.now()).toBeGreaterThan(result.deadline);
      }
      return result;
    },
  };
  const response = await withLoopback(application(backend), (server) =>
    request(server)
      .get("/moderate/circle-reference")
      .set("Host", new URL(origin).host)
      .set("Cookie", `dne_staff=${f.admin}`),
  );
  expect(nativeReady).toBe(true);
  expect(response.status).toBe(403);
  expect(response.text).not.toContain(f.adminId);
  expect(response.text).not.toContain(expires.toISOString());
}, 10000);
