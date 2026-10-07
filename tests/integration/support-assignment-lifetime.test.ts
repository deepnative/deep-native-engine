import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, beforeEach, afterAll, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import {
  supportAssignmentStore,
  type AssignmentInput,
  type AssignmentResult,
} from "../../src/support-assignment.ts";
import { testPool } from "../support/database.ts";
import request from "supertest";
import { app } from "../../src/app.ts";
import { csrf, COOKIE } from "../../src/session.ts";
import { withLoopback } from "../support/loopback-server.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  support = supportRequestStore(pool),
  subject = supportAssignmentStore(pool, "lifetime-synthetic-secret");
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals,cohorts CASCADE"));
afterAll(() => pool.end());
const fresh = () => randomBytes(32).toString("hex");
function value<T>(r: AssignmentResult<T>): T {
  expect(r.kind).toBe("ready");
  if (r.kind !== "ready") throw Error("Missing current result");
  return r.value;
}
async function fixture() {
  const owner = fresh(),
    admin = fresh(),
    operator = fresh(),
    expires = new Date(Date.now() + 3600000);
  await members.create(owner, { background: "explorer", goal: "everyday" });
  const member = await members.session(owner);
  if (member.kind !== "active") throw Error("Missing member");
  const adminId = await auth.provisionStaff(admin, "platform_admin", expires),
    staffId = await auth.provisionStaff(operator, "operator", expires);
  const created = await support.create(owner, {
    idempotencyKey: randomUUID(),
    subject: "PRIVATE-SUBJECT",
    body: "PRIVATE-CONTENT",
  });
  if (!("receipt" in created)) throw Error("Missing request");
  const input: AssignmentInput = {
    requestId: created.receipt.requestId,
    staffId,
    idempotencyKey: randomUUID(),
    startsAt: new Date(Date.now() - 60000),
    expiresAt: new Date(+expires - 1000),
  };
  return {
    owner,
    admin,
    operator,
    adminId,
    staffId,
    memberId: member.learner.id,
    requestId: input.requestId,
    input,
  };
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  return { release, wait };
}
async function blockedBy(pid: number) {
  for (let n = 0; n < 400; n++) {
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
async function databaseExpiryDeadline(expires: Date) {
  const row = (
    await pool.query<{ remaining: string }>(
      "SELECT EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000 AS remaining",
      [expires],
    )
  ).rows[0];
  const remaining = Number(row?.remaining);
  expect(Number.isFinite(remaining)).toBe(true);
  // Anchor after receiving the real database observation. Host wall-clock skew
  // must not let synchronous handback finish before PostgreSQL authority expires.
  return performance.now() + Math.max(0, remaining) + 25;
}
async function afterExpiry(at: Date) {
  await pool.query(
    "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.025)",
    [at],
  );
}
const mutations = [
  {
    name: "administrator role",
    sql: "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
    key: "adminId",
    historical: false,
  },
  {
    name: "administrator revocation",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    key: "adminId",
    historical: false,
  },
  {
    name: "administrator expiry",
    sql: "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    key: "adminId",
    historical: false,
  },
  {
    name: "operator role",
    sql: "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
    key: "staffId",
    historical: true,
  },
  {
    name: "operator revocation",
    sql: "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    key: "staffId",
    historical: true,
  },
  {
    name: "operator expiry",
    sql: "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    key: "staffId",
    historical: true,
  },
  {
    name: "request withdrawal",
    sql: "UPDATE support_requests SET subject=NULL,body=NULL,withdrawn_at=clock_timestamp() WHERE id=$1",
    key: "requestId",
    historical: true,
  },
  {
    name: "workspace deletion fence",
    sql: "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
    key: "memberId",
    historical: false,
  },
  {
    name: "member deletion",
    sql: "DELETE FROM principals WHERE id=$1",
    key: "memberId",
    historical: false,
  },
] as const;
const operations = ["check", "assign", "history", "revoke"] as const;
for (const operation of operations)
  for (const change of mutations) {
    const expected =
      change.historical && (operation === "history" || operation === "revoke")
        ? "ready"
        : "denied";
    async function invocation(f: Awaited<ReturnType<typeof fixture>>) {
      const saved =
        operation === "history" || operation === "revoke"
          ? value(await subject.assign(f.admin, f.input))
          : null;
      return (port = subject): Promise<AssignmentResult<unknown>> =>
        operation === "check"
          ? port.check(f.admin, f.requestId, f.staffId)
          : operation === "assign"
            ? port.assign(f.admin, f.input)
            : operation === "history"
              ? port.history(f.admin, f.requestId)
              : port.revoke(f.admin, f.requestId, saved!.grantId);
    }
    it(`SUPADM-06-LIFETIME ${operation}: ${change.name} wins first at an observed native lock and the operation ${expected}`, async () => {
      const f = await fixture(),
        invoke = await invocation(f),
        holder = await pool.connect();
      let pending: Promise<AssignmentResult<unknown>> | undefined;
      try {
        await holder.query("BEGIN");
        const pid = (await holder.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid as number;
        await holder.query(change.sql, [f[change.key]]);
        pending = invoke();
        await blockedBy(pid);
        await holder.query("COMMIT");
        expect((await pending).kind).toBe(expected);
        expect((await invoke()).kind).toBe(expected);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        await Promise.allSettled(pending ? [pending] : []);
      }
    });
    it(`SUPADM-06-LIFETIME ${operation}: current operation wins before ${change.name}, then a fresh operation ${expected}`, async () => {
      const f = await fixture(),
        invoke = await invocation(f),
        entered = barrier(),
        resume = barrier();
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
              if (sql.startsWith("WITH handoff")) {
                entered.release();
                await resume.wait;
              }
              return result;
            }) as PoolClient["query"],
            release: client.release.bind(client),
          };
        },
      } as unknown as Pool;
      const pending = invoke(supportAssignmentStore(scoped));
      try {
        await Promise.race([
          entered.wait,
          pending.then(() => {
            throw Error("Operation completed before fence");
          }),
        ]);
        changing = pool.query(change.sql, [f[change.key]]);
        await blockedBy(pid);
        resume.release();
        expect((await pending).kind).toBe("ready");
        await changing;
        // An identical saved creation is historical readback; new work still requires
        // current eligibility after the first operation has committed.
        const freshResult =
          operation === "assign"
            ? await subject.assign(f.admin, {
                ...f.input,
                idempotencyKey: randomUUID(),
              })
            : await invoke();
        expect(freshResult.kind).toBe(expected);
      } finally {
        resume.release();
        await Promise.allSettled([pending, ...(changing ? [changing] : [])]);
      }
    });
  }
it.each(["commit", "release", "observation"])(
  "SUPADM-06-LIFETIME actual administrator expiry through %s withholds native response and preserves fresh recovery",
  async (phase) => {
    const f = await fixture(),
      expires = new Date(Date.now() + 1600);
    await pool.query("UPDATE principals SET expires_at=$1 WHERE id=$2", [
      expires,
      f.adminId,
    ]);
    const handbackDeadline =
      phase === "release" ? await databaseExpiryDeadline(expires) : 0;
    let releases = 0,
      commits = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            const r = await client.query(sql, values);
            if (sql === "COMMIT") {
              commits++;
              if (phase === "commit") await afterExpiry(expires);
            }
            if (phase === "observation" && sql.startsWith("WITH handoff"))
              await afterExpiry(expires);
            return r;
          }) as PoolClient["query"],
          release: (error?: Error) => {
            releases++;
            if (phase === "release") {
              while (performance.now() <= handbackDeadline) {
                /* Exercise synchronous native handback at actual expiry. */
              }
            }
            client.release(error);
          },
        };
      },
    } as unknown as Pool;
    const result = await supportAssignmentStore(scoped).assign(
      f.admin,
      f.input,
    );
    expect(result).toEqual({
      kind: phase === "observation" ? "denied" : "unavailable",
    });
    expect(
      (
        await pool.query("SELECT $1::timestamptz<=clock_timestamp() expired", [
          expires,
        ])
      ).rows[0].expired,
    ).toBe(true);
    expect(releases).toBe(1);
    expect(commits).toBe(phase === "observation" ? 0 : 1);
    const freshAdmin = fresh();
    await auth.provisionStaff(
      freshAdmin,
      "platform_admin",
      new Date(Date.now() + 60000),
    );
    const history = value(await subject.history(freshAdmin, f.requestId));
    expect(history.items).toHaveLength(phase === "observation" ? 0 : 1);
  },
  10000,
);
it.each(["before", "after"])(
  "SUPADM-07-RECOVERY %s-COMMIT lost reply returns sanitized unavailability and exact own-key inspection reveals only durable state",
  async (phase) => {
    const f = await fixture();
    let attempts = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            if (sql === "COMMIT") {
              attempts++;
              if (phase === "before") throw Error("PRIVATE-COMMIT-DETAIL");
              const result = await client.query(sql, values);
              throw Object.assign(Error("PRIVATE-COMMIT-DETAIL"), { result });
            }
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: client.release.bind(client),
        };
      },
    } as unknown as Pool;
    expect(
      await supportAssignmentStore(scoped).assign(f.admin, f.input),
    ).toEqual({ kind: "unavailable" });
    expect(attempts).toBe(1);
    const recovered = value(
      await subject.history(
        f.admin,
        f.requestId,
        undefined,
        f.input.idempotencyKey,
      ),
    );
    expect(recovered.items).toHaveLength(phase === "after" ? 1 : 0);
    if (phase === "after") {
      expect(value(await subject.assign(f.admin, f.input)).disposition).toBe(
        "replayed",
      );
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM support_request_events WHERE action='grant-created'",
          )
        ).rows[0].n,
      ).toBe(1);
    }
  },
);
it.each(["audit", "rollback", "release"])(
  "SUPADM-07-RECOVERY %s fault releases native locks, does not retry, and leaves inspectable truthful state",
  async (phase) => {
    const f = await fixture();
    let releases = 0,
      events = 0,
      commits = 0;
    const scoped = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (async (sql: string, values?: unknown[]) => {
            if (sql.startsWith("INSERT INTO support_request_events")) {
              events++;
              if (phase !== "release") throw Error("PRIVATE-AUDIT-FAILURE");
            }
            if (sql === "ROLLBACK" && phase === "rollback")
              throw Error("PRIVATE-ROLLBACK-FAILURE");
            if (sql === "COMMIT") commits++;
            return client.query(sql, values);
          }) as PoolClient["query"],
          release: (error?: Error) => {
            releases++;
            client.release(error);
            if (phase === "release") throw Error("PRIVATE-RELEASE-FAILURE");
          },
        };
      },
    } as unknown as Pool;
    expect(
      await supportAssignmentStore(scoped).assign(f.admin, f.input),
    ).toEqual({ kind: "unavailable" });
    expect(releases).toBe(1);
    expect(events).toBe(1);
    expect(commits).toBe(phase === "release" ? 1 : 0);
    expect(
      value(
        await subject.history(
          f.admin,
          f.requestId,
          undefined,
          f.input.idempotencyKey,
        ),
      ).items,
    ).toHaveLength(phase === "release" ? 1 : 0);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout='500ms'");
      await holder.query("SELECT id FROM principals WHERE id=$1 FOR UPDATE", [
        f.adminId,
      ]);
      await holder.query("ROLLBACK");
    } finally {
      holder.release();
    }
  },
);
it("SUPADM-07-RECOVERY real pool starvation is bounded and its late acquired client is discarded without running assignment", async () => {
  const f = await fixture(),
    limited = new Pool({
      connectionString: process.env.DNE_TEST_DATABASE_URL,
      max: 1,
    }),
    held = await limited.connect();
  let released = false;
  try {
    const result = await supportAssignmentStore(limited).assign(
      f.admin,
      f.input,
    );
    expect(result).toEqual({ kind: "unavailable" });
    held.release();
    released = true;
    await limited.end();
    expect(value(await subject.history(f.admin, f.requestId)).items).toEqual(
      [],
    );
  } finally {
    if (!released) {
      held.release();
      await limited.end();
    }
  }
}, 10000);
it("SUPADM-07-RECOVERY actual query timeout destroys the owned client and never commits or automatically retries", async () => {
  const f = await fixture();
  let statements = 0,
    releases = 0;
  const scoped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (async (sql: string, values?: unknown[]) => {
          if (sql.startsWith("SELECT id FROM principals")) {
            statements++;
            return client.query("SELECT pg_sleep(20)");
          }
          return client.query(sql, values);
        }) as PoolClient["query"],
        release: (error?: Error) => {
          releases++;
          client.release(error);
        },
      };
    },
  } as unknown as Pool;
  expect(await supportAssignmentStore(scoped).assign(f.admin, f.input)).toEqual(
    { kind: "unavailable" },
  );
  expect(statements).toBe(1);
  expect(releases).toBe(1);
  expect(value(await subject.history(f.admin, f.requestId)).items).toEqual([]);
}, 10000);
it("SUPADM-06-LIFETIME a finite scheduled grant gains no early access and actual expiry removes fresh access but retains historical recovery", async () => {
  const f = await fixture(),
    expires = new Date(Date.now() + 1500),
    saved = value(
      await subject.assign(f.admin, {
        ...f.input,
        startsAt: new Date(Date.now() + 750),
        expiresAt: expires,
      }),
    );
  expect(
    (
      await support.operatorDetail(f.operator, {
        requestId: f.requestId,
        grantId: saved.grantId,
      })
    ).kind,
  ).toBe("denied");
  expect(
    value(await subject.history(f.admin, f.requestId)).items[0]!.state,
  ).toBe("scheduled");
  await afterExpiry(expires);
  expect(
    (
      await support.operatorDetail(f.operator, {
        requestId: f.requestId,
        grantId: saved.grantId,
      })
    ).kind,
  ).toBe("denied");
  const history = value(
    await subject.history(
      f.admin,
      f.requestId,
      undefined,
      f.input.idempotencyKey,
    ),
  );
  expect(history.items[0]!.state).toBe("expired");
  expect(
    value(await subject.revoke(f.admin, f.requestId, saved.grantId))
      .disposition,
  ).toBe("revoked");
}, 10000);
for (const order of ["lower", "higher"] as const)
  for (const outcome of ["commit", "rollback"] as const)
    it(`SUPADM-03-IDEMPOTENCY ${order} request first ${outcome} serializes one admin key across different owners after a real lock wait`, async () => {
      const f = await fixture(),
        other = await fixture(),
        inputs = [f.input, { ...f.input, requestId: other.requestId }].sort(
          (a, b) => a.requestId.localeCompare(b.requestId),
        );
      const first = inputs[order === "lower" ? 0 : 1]!,
        second = inputs[order === "lower" ? 1 : 0]!,
        entered = barrier(),
        resume = barrier();
      let pid = 0,
        competing: Promise<AssignmentResult<unknown>> | undefined;
      const scoped = {
        connect: async () => {
          const client = await pool.connect();
          pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
            .pid;
          return {
            query: (async (sql: string, values?: unknown[]) => {
              const r = await client.query(sql, values);
              if (sql.startsWith("WITH handoff")) {
                entered.release();
                await resume.wait;
                if (outcome === "rollback")
                  throw Error("Synthetic first writer aborted before commit");
              }
              return r;
            }) as PoolClient["query"],
            release: client.release.bind(client),
          };
        },
      } as unknown as Pool;
      const pending = supportAssignmentStore(scoped).assign(f.admin, first);
      try {
        await Promise.race([
          entered.wait,
          pending.then(() => {
            throw Error("First writer completed before fence");
          }),
        ]);
        competing = subject.assign(f.admin, second);
        await blockedBy(pid);
        resume.release();
        expect((await pending).kind).toBe(
          outcome === "commit" ? "ready" : "unavailable",
        );
        expect((await competing).kind).toBe(
          outcome === "commit" ? "conflict" : "ready",
        );
        const rows = (
          await pool.query(
            "SELECT request_id FROM support_request_grants WHERE granted_by=$1 AND idempotency_key=$2",
            [f.adminId, f.input.idempotencyKey],
          )
        ).rows;
        expect(rows).toEqual([
          { request_id: (outcome === "commit" ? first : second).requestId },
        ]);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int n FROM support_request_events WHERE action='grant-created'",
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        resume.release();
        await Promise.allSettled([pending, ...(competing ? [competing] : [])]);
      }
    });
for (const authority of ["operator", "member", "grant"] as const)
  for (const phase of ["commit", "release"] as const)
    it(`SUPADM-06-LIFETIME actual ${authority} expiry at ${phase} withholds possibly committed creation`, async () => {
      const f = await fixture(),
        expires = new Date(Date.now() + 1600),
        input = { ...f.input };
      if (authority === "operator") {
        await pool.query("UPDATE principals SET expires_at=$1 WHERE id=$2", [
          expires,
          f.staffId,
        ]);
        input.expiresAt = expires;
      }
      if (authority === "member")
        await pool.query("UPDATE principals SET expires_at=$1 WHERE id=$2", [
          expires,
          f.memberId,
        ]);
      if (authority === "grant") input.expiresAt = expires;
      const handbackDeadline =
        phase === "release" ? await databaseExpiryDeadline(expires) : 0;
      let commits = 0,
        releases = 0;
      const scoped = {
        connect: async () => {
          const client = await pool.connect();
          return {
            query: (async (sql: string, values?: unknown[]) => {
              const r = await client.query(sql, values);
              if (sql === "COMMIT") {
                commits++;
                if (phase === "commit") await afterExpiry(expires);
              }
              return r;
            }) as PoolClient["query"],
            release: (error?: Error) => {
              releases++;
              if (phase === "release")
                while (performance.now() <= handbackDeadline) {
                  /* Actual synchronous handback crossing the finite authority. */
                }
              client.release(error);
            },
          };
        },
      } as unknown as Pool;
      expect(
        await supportAssignmentStore(scoped).assign(f.admin, input),
      ).toEqual({ kind: "unavailable" });
      expect(commits).toBe(1);
      expect(releases).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT $1::timestamptz<=clock_timestamp() expired",
            [expires],
          )
        ).rows[0].expired,
      ).toBe(true);
      const recovered = value(
        await subject.history(
          f.admin,
          f.requestId,
          undefined,
          f.input.idempotencyKey,
        ),
      );
      expect(recovered.items).toHaveLength(1);
      expect(recovered.items[0]!.state).toBe(
        authority === "member" ? "ineffective" : "expired",
      );
    }, 10000);
it.each(["read", "write"])(
  "SUPADM-06-LIFETIME actual database authority expires before synchronous HTTP %s acceptance and metadata/success are withheld",
  async (kind) => {
    const f = await fixture(),
      expires = new Date(Date.now() + 1600);
    await pool.query("UPDATE principals SET expires_at=$1 WHERE id=$2", [
      expires,
      f.adminId,
    ]);
    const wrapped = {
      ...subject,
      admin: async (token: string) => {
        const r = await subject.admin(token);
        expect(r.kind).toBe("ready");
        await afterExpiry(expires);
        return r;
      },
      assign: async (token: string, input: AssignmentInput) => {
        const r = await subject.assign(token, input);
        expect(r.kind).toBe("ready");
        await afterExpiry(expires);
        return r;
      },
    };
    const origin = "http://127.0.0.1:3000",
      secret = "synthetic-response-deadline",
      cookie = `${COOKIE}=${f.owner}; dne_staff=${f.admin}`;
    await withLoopback(
      app(members, {
        origin,
        secret,
        mode: "test",
        localStaffEntry: true,
        localSupportAssignment: true,
        supportAssignment: wrapped,
      }),
      async (server) => {
        const response =
          kind === "read"
            ? await request(server)
                .get("/operator/support-assignment")
                .set("Host", new URL(origin).host)
                .set("Cookie", cookie)
            : await request(server)
                .post("/operator/support-assignment/assign")
                .set("Host", new URL(origin).host)
                .set("Origin", origin)
                .set("Cookie", cookie)
                .type("form")
                .send({
                  ...f.input,
                  startsAt: f.input.startsAt.toISOString(),
                  expiresAt: f.input.expiresAt.toISOString(),
                  csrf: csrf(f.admin, secret),
                  confirm: "yes",
                });
        expect(response.status).toBe(kind === "read" ? 403 : 503);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.text.includes("PRIVATE-CONTENT")).toBe(false);
        if (kind === "write") {
          expect(response.text).toContain(f.input.idempotencyKey);
          expect(response.text).toContain("may already have committed");
          expect(response.text).not.toContain("Support assignment recorded");
        }
      },
    );
    expect(
      (await pool.query("SELECT count(*)::int n FROM support_request_grants"))
        .rows[0].n,
    ).toBe(kind === "write" ? 1 : 0);
  },
  10000,
);
