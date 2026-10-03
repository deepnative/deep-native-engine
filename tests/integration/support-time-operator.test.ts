import { memberExportStore } from "../../src/member-export.ts";
import { ledgerReconciliationStore } from "../../src/ledger-reconciliation.ts";
import request from "supertest";
import { app } from "../../src/app.ts";
import { COOKIE, csrf } from "../../src/session.ts";
import { listenLoopback, closeLoopback } from "../support/loopback-server.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { testPool } from "../support/database.ts";
import type { Pool } from "pg";
import { performance } from "node:perf_hooks";
const pool = testPool(),
  members = store(pool),
  support = supportRequestStore(pool),
  auth = authorizationStore(pool),
  ledger = syntheticLedger(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => pool.end());
async function fixture(budgetExpiresAt?: Date) {
  const token = randomBytes(32).toString("hex"),
    adminToken = randomBytes(32).toString("hex"),
    operatorToken = randomBytes(32).toString("hex"),
    otherToken = randomBytes(32).toString("hex");
  await members.create(token, { background: "professional", goal: "work" });
  const member = await members.session(token);
  if (member.kind !== "active" || !support.time)
    throw Error("Missing invented member");
  const expiresAt = new Date(Date.now() + 3600000),
    startsAt = new Date(Date.now() - 60000);
  await auth.provisionStaff(adminToken, "platform_admin", expiresAt);
  const operatorId = await auth.provisionStaff(
      operatorToken,
      "operator",
      expiresAt,
    ),
    otherId = await auth.provisionStaff(otherToken, "operator", expiresAt);
  const budgetId = await ledger.grant(
    member.learner.id,
    "support_minutes",
    20,
    randomUUID(),
    {
      startsAt: startsAt.toISOString(),
      expiresAt: (budgetExpiresAt ?? expiresAt).toISOString(),
    },
  );
  const created = await support.create(token, {
    idempotencyKey: randomUUID(),
    subject: "Invented bounded support",
    body: "Private sample, no real service",
  });
  if (!("receipt" in created)) throw Error("Missing request");
  const requestId = created.receipt.requestId;
  const allocated = await support.time.allocate(
    token,
    requestId,
    randomUUID(),
    20,
  );
  if (!("receipt" in allocated)) throw Error("Missing allocated minutes");
  const allocationId = allocated.receipt.allocationId;
  return {
    token,
    memberId: member.learner.id,
    adminToken,
    operatorToken,
    otherToken,
    operatorId,
    otherId,
    budgetId,
    requestId,
    allocationId,
    startsAt,
    expiresAt,
  };
}
it("requires a distinct exact time grant; a note grant and member/background confer no begin privilege", async () => {
  const f = await fixture(),
    time = support.time!;
  const input = {
    requestId: f.requestId,
    allocationId: f.allocationId,
    staffId: f.operatorId,
    role: "operator" as const,
    idempotencyKey: randomUUID(),
    startsAt: f.startsAt,
    expiresAt: f.expiresAt,
  };
  const old = await support.grant(f.adminToken, input);
  if (!("grantId" in old)) throw Error("Missing note grant");
  const scope = {
    requestId: f.requestId,
    allocationId: f.allocationId,
    grantId: old.grantId,
  };
  expect(await time.begin(f.operatorToken, scope, randomUUID())).toEqual({
    kind: "denied",
  });
  expect(await time.grant(f.token, input)).toEqual({ kind: "denied" });
  expect(await time.grant(f.operatorToken, input)).toEqual({ kind: "denied" });
  const granted = await time.grant(f.adminToken, input);
  expect(granted.kind).toBe("created");
  if (!("grantId" in granted)) throw Error("Missing time grant");
  expect(await time.grant(f.adminToken, input)).toEqual({
    kind: "replayed",
    grantId: granted.grantId,
  });
  expect(
    await time.grant(f.adminToken, { ...input, staffId: f.otherId }),
  ).toEqual({ kind: "conflict" });
  const exact = { ...scope, grantId: granted.grantId },
    key = randomUUID();
  expect(await time.begin(f.token, exact, key)).toEqual({ kind: "denied" });
  expect(await time.begin(f.otherToken, exact, key)).toEqual({
    kind: "denied",
  });
  const begun = await time.begin(f.operatorToken, exact, key);
  expect(begun.kind).toBe("applied");
  expect(await time.begin(f.operatorToken, exact, key)).toMatchObject({
    kind: "replayed",
    receipt: { state: "begun", held: 20, consumed: 0 },
  });
  expect(await time.begin(f.operatorToken, exact, randomUUID())).toEqual({
    kind: "conflict",
  });
  expect(await time.revoke(f.operatorToken, granted.grantId)).toEqual({
    kind: "denied",
  });
  expect(await time.revoke(f.adminToken, granted.grantId)).toEqual({
    kind: "revoked",
  });
  expect(await time.revoke(f.adminToken, granted.grantId)).toEqual({
    kind: "already-revoked",
  });
  expect(await time.begin(f.operatorToken, exact, key)).toEqual({
    kind: "denied",
  });
  expect(await time.receipt(f.token, f.requestId)).toMatchObject({
    kind: "ready",
    value: {
      state: "needs_reconciliation",
      held: 20,
      consumed: 0,
      released: 0,
    },
  });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [f.budgetId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 20, consumed: 0 }]);
});
it("allows only one durable begin winner when two independently granted operators compete", async () => {
  const f = await fixture(),
    time = support.time!;
  const scopes = [];
  for (const staffId of [f.operatorId, f.otherId]) {
    const granted = await time.grant(f.adminToken, {
      requestId: f.requestId,
      allocationId: f.allocationId,
      staffId,
      role: "operator",
      idempotencyKey: randomUUID(),
      startsAt: f.startsAt,
      expiresAt: f.expiresAt,
    });
    if (!("grantId" in granted)) throw Error("Missing time grant");
    scopes.push({
      requestId: f.requestId,
      allocationId: f.allocationId,
      grantId: granted.grantId,
    });
  }
  const results = await Promise.all([
    time.begin(f.operatorToken, scopes[0]!, randomUUID()),
    time.begin(f.otherToken, scopes[1]!, randomUUID()),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["applied", "conflict"]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_events WHERE allocation_id=$1 AND action='begun'",
        [f.allocationId],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
        [f.allocationId],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

async function granted(
  f: Awaited<ReturnType<typeof fixture>>,
  expiresAt = f.expiresAt,
) {
  const time = support.time!;
  const granted = await time.grant(f.adminToken, {
    requestId: f.requestId,
    allocationId: f.allocationId,
    staffId: f.operatorId,
    role: "operator",
    idempotencyKey: randomUUID(),
    startsAt: f.startsAt,
    expiresAt,
  });
  if (!("grantId" in granted)) throw Error("Missing time grant");
  const scope = {
    requestId: f.requestId,
    allocationId: f.allocationId,
    grantId: granted.grantId,
  };
  return scope;
}
async function begun(f: Awaited<ReturnType<typeof fixture>>) {
  const scope = await granted(f);
  expect(
    (await support.time!.begin(f.operatorToken, scope, randomUUID())).kind,
  ).toBe("applied");
  return scope;
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function observed(afterQuery?: string) {
  const connected = latch(),
    reached = latch(),
    resume = latch();
  const state = { pid: 0, calls: [] as string[] };
  const use = supportRequestStore({
    async connect() {
      const client = await pool.connect();
      state.pid = (
        await client.query("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      connected.release();
      let paused = false;
      return {
        async query(sql: string, values?: unknown[]) {
          state.calls.push(sql);
          const result = await client.query(sql, values);
          if (!paused && afterQuery && sql.startsWith(afterQuery)) {
            paused = true;
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release(error?: Error) {
          client.release(error);
        },
      };
    },
  } as unknown as Pool);
  return { use, connected, reached, resume, state };
}
it("allocates and partially settles the maximum 120-minute ceiling within a bounded single-transaction query budget", async () => {
  const f = await fixture();
  await support.time!.cancel(f.token, f.requestId, f.allocationId);
  await ledger.grant(f.memberId, "support_minutes", 120, randomUUID(), {
    startsAt: f.startsAt.toISOString(),
    expiresAt: f.expiresAt.toISOString(),
  });
  const allocation = observed(),
    started = performance.now();
  const held = await allocation.use.time!.allocate(
    f.token,
    f.requestId,
    randomUUID(),
    120,
  );
  if (!("receipt" in held)) throw Error("Maximum allocation missing");
  expect(held.receipt).toMatchObject({ ceiling: 120, held: 120, consumed: 0 });
  expect(performance.now() - started).toBeLessThan(10000);
  expect(allocation.state.calls.length).toBeLessThanOrEqual(1600);
  expect(allocation.state.calls.filter((sql) => sql === "COMMIT")).toHaveLength(
    1,
  );
  const scope = await begun({ ...f, allocationId: held.receipt.allocationId });
  const settlement = observed(),
    settledAt = performance.now(),
    start = new Date(Date.now() - 3 * 3600000),
    end = new Date(+start + 110 * 60000);
  expect(
    await settlement.use.time!.record(f.operatorToken, scope, randomUUID(), {
      supportStart: start,
      supportEnd: end,
      preparationStart: end,
      preparationEnd: new Date(+end + 5 * 60000),
    }),
  ).toMatchObject({
    kind: "applied",
    receipt: { consumed: 115, released: 5, held: 0 },
  });
  expect(performance.now() - settledAt).toBeLessThan(10000);
  expect(settlement.state.calls.length).toBeLessThanOrEqual(1600);
  expect(settlement.state.calls.filter((sql) => sql === "COMMIT")).toHaveLength(
    1,
  );
});
async function blocked(pid: number, by: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      (
        await pool.query(
          "SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) blocked",
          [by, pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected actual PostgreSQL lock wait was not observed");
}
it.each(["budget", "time-grant"] as const)(
  "denies a new begin after %s expires during an observed row-lock wait without charging or releasing the hold",
  async (expiryKind) => {
    const expiry = new Date(Date.now() + 2000),
      f = await fixture(expiryKind === "budget" ? expiry : undefined),
      scope = await granted(
        f,
        expiryKind === "time-grant" ? expiry : f.expiresAt,
      ),
      waiter = observed(),
      blocker = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      await blocker.query(
        expiryKind === "budget"
          ? "SELECT id FROM synthetic_entitlement_grants WHERE id=$1 FOR UPDATE"
          : "SELECT id FROM workspaces WHERE id=$1 FOR UPDATE",
        [expiryKind === "budget" ? f.budgetId : f.memberId],
      );
      pending = waiter.use.time!.begin(f.operatorToken, scope, randomUUID());
      await waiter.connected.wait;
      await blocked(waiter.state.pid, pid);
      await blocker.query(
        "SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())+0.01))",
        [expiry],
      );
      await blocker.query("COMMIT");
      expect(await pending).toEqual({
        kind: expiryKind === "budget" ? "insufficient" : "denied",
      });
      expect(await support.time!.receipt(f.token, f.requestId)).toMatchObject({
        kind: "ready",
        value: { state: "allocated", held: 20, consumed: 0, released: 0 },
      });
      expect(
        (
          await pool.query(
            "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
            [f.budgetId],
          )
        ).rows,
      ).toEqual([{ available: 0, reserved: 20, consumed: 0 }]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
  },
);
it.each(["withdrawal", "begin"] as const)(
  "serializes %s winning a withdrawal-versus-begin race and preserves the corresponding known or unknown work state",
  async (first) => {
    const f = await fixture(),
      scope = await granted(f),
      winner = observed(
        first === "withdrawal"
          ? "UPDATE support_requests SET subject=NULL"
          : "UPDATE support_time_allocations SET state='begun'",
      ),
      loser = observed();
    const winning =
      first === "withdrawal"
        ? winner.use.withdraw(f.token, f.requestId)
        : winner.use.time!.begin(f.operatorToken, scope, randomUUID());
    let losing: Promise<unknown> | undefined;
    try {
      await winner.reached.wait;
      losing =
        first === "withdrawal"
          ? loser.use.time!.begin(f.operatorToken, scope, randomUUID())
          : loser.use.withdraw(f.token, f.requestId);
      await loser.connected.wait;
      await blocked(loser.state.pid, winner.state.pid);
      winner.resume.release();
      expect((await winning).kind).toBe(
        first === "withdrawal" ? "withdrawn" : "applied",
      );
      expect(await losing).toMatchObject({ kind: "withdrawn" });
      expect(await support.time!.receipt(f.token, f.requestId)).toMatchObject({
        kind: "ready",
        value: {
          state: first === "withdrawal" ? "cancelled" : "needs_reconciliation",
          held: first === "withdrawal" ? 0 : 20,
          consumed: 0,
          released: first === "withdrawal" ? 20 : 0,
        },
      });
      expect(
        (
          await pool.query(
            "SELECT subject,body FROM support_requests WHERE id=$1",
            [f.requestId],
          )
        ).rows,
      ).toEqual([{ subject: null, body: null }]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
            [f.allocationId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      winner.resume.release();
      await winning;
      await losing;
    }
  },
);
function intervals(start: Date) {
  const end = new Date(start.valueOf() + 10 * 60000);
  return {
    supportStart: start,
    supportEnd: end,
    preparationStart: end,
    preparationEnd: new Date(end.valueOf() + 5 * 60000),
  };
}
it.each(["before", "after", "handback"] as const)(
  "withholds HTTP success on %s COMMIT uncertainty and recovers only through a fresh read and exact replay",
  async (failure) => {
    const f = await fixture(),
      scope = await begun(f),
      key = randomUUID(),
      segments = intervals(new Date(Date.now() - 3600000)),
      calls: string[] = [];
    let connections = 0;
    const uncertain = supportRequestStore({
      async connect() {
        connections++;
        const client = await pool.connect();
        return {
          async query(sql: string, values?: unknown[]) {
            calls.push(sql);
            if (sql === "COMMIT" && failure === "before")
              throw Error("Invented failure before commit");
            const result = await client.query(sql, values);
            if (sql === "COMMIT" && failure === "after")
              throw Error("Invented lost commit receipt");
            return result;
          },
          release(error?: Error) {
            client.release(error);
            if (failure === "handback")
              throw Error("Invented failed connection handback");
          },
        };
      },
    } as unknown as Pool);
    const origin = "http://127.0.0.1:3000",
      secret = "invented-support-time-uncertainty",
      server = await listenLoopback(
        app(members, { origin, secret, supportRequests: uncertain }),
      );
    try {
      const response = await request(server)
        .post(`/operator/support-time/${f.requestId}/record`)
        .set("Host", "127.0.0.1:3000")
        .set("Origin", origin)
        .set("Cookie", `${COOKIE}=${f.operatorToken}`)
        .type("form")
        .send({
          csrf: csrf(f.operatorToken, secret),
          allocationId: scope.allocationId,
          grantId: scope.grantId,
          idempotencyKey: key,
          confirm: "yes",
          supportStart: segments.supportStart.toISOString(),
          supportEnd: segments.supportEnd.toISOString(),
          preparationStart: segments.preparationStart.toISOString(),
          preparationEnd: segments.preparationEnd.toISOString(),
        })
        .expect(503);
      expect(response.text).toContain("Nothing is retried automatically");
      if (failure === "handback")
        expect(response.text).toContain('href="/operator/support-time"');
      expect(connections).toBe(1);
      expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(await support.time!.receipt(f.token, f.requestId)).toMatchObject({
        kind: "ready",
        value: {
          state: failure === "before" ? "begun" : "completed",
          held: failure === "before" ? 20 : 0,
          consumed: failure === "before" ? 0 : 15,
          released: failure === "before" ? 0 : 5,
        },
      });
      expect(
        await support.time!.record(f.operatorToken, scope, key, segments),
      ).toMatchObject({
        kind: failure === "before" ? "applied" : "replayed",
        receipt: { consumed: 15, released: 5, held: 0 },
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
            [f.allocationId],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      expect(
        (
          await pool.query(
            "SELECT operation,count(*)::integer n FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation IN ('consume','release') GROUP BY operation ORDER BY operation",
            [f.budgetId],
          )
        ).rows,
      ).toEqual([
        { operation: "consume", n: 15 },
        { operation: "release", n: 5 },
      ]);
    } finally {
      await closeLoopback(server);
    }
  },
);
it("records ten support plus five preparation minutes, consumes fifteen and releases five exactly once", async () => {
  const f = await fixture(),
    scope = await begun(f),
    key = randomUUID(),
    segments = intervals(new Date(Date.now() - 3600000));
  const recorded = await support.time!.record(
    f.operatorToken,
    scope,
    key,
    segments,
  );
  expect(recorded).toMatchObject({
    kind: "applied",
    receipt: {
      state: "completed",
      held: 0,
      consumed: 15,
      released: 5,
      supportMinutes: 10,
      preparationMinutes: 5,
    },
  });
  expect(
    await support.time!.record(f.operatorToken, scope, key, segments),
  ).toMatchObject({ kind: "replayed", receipt: { consumed: 15, released: 5 } });
  expect(
    await support.time!.record(f.operatorToken, scope, key, {
      ...segments,
      supportStart: new Date(segments.supportStart.valueOf() - 60000),
    }),
  ).toEqual({ kind: "conflict" });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [f.budgetId],
      )
    ).rows,
  ).toEqual([{ available: 5, reserved: 0, consumed: 15 }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
        [f.allocationId],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (
      await pool.query(
        "SELECT operation,count(*)::integer n FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation IN ('consume','release') GROUP BY operation ORDER BY operation",
        [f.budgetId],
      )
    ).rows,
  ).toEqual([
    { operation: "consume", n: 15 },
    { operation: "release", n: 5 },
  ]);
});
it("settles a previously begun hold after actual budget expiry and expires unused minutes instead of returning usable units", async () => {
  const budgetExpiry = new Date(Date.now() + 2000),
    f = await fixture(budgetExpiry),
    scope = await begun(f);
  await pool.query(
    "SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())+0.01))",
    [budgetExpiry],
  );
  expect(
    await support.time!.record(
      f.operatorToken,
      scope,
      randomUUID(),
      intervals(new Date(Date.now() - 3600000)),
    ),
  ).toMatchObject({ kind: "applied", receipt: { consumed: 15, released: 5 } });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed,expired FROM synthetic_entitlement_grants WHERE id=$1",
        [f.budgetId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 0, consumed: 15, expired: 5 }]);
});
it("rejects future, stale, overlapping and over-ceiling intervals without recording or charging", async () => {
  const f = await fixture(),
    scope = await begun(f);
  for (const start of [
    new Date(Date.now() + 3600000),
    new Date(Date.now() - 25 * 3600000),
  ])
    expect(
      await support.time!.record(
        f.operatorToken,
        scope,
        randomUUID(),
        intervals(start),
      ),
    ).toEqual({ kind: "denied" });
  const segments = intervals(new Date(Date.now() - 3600000));
  expect(
    await support.time!.record(f.operatorToken, scope, randomUUID(), {
      ...segments,
      preparationStart: segments.supportStart,
    }),
  ).toEqual({ kind: "denied" });
  expect(
    await support.time!.record(f.operatorToken, scope, randomUUID(), {
      ...segments,
      preparationEnd: new Date(segments.preparationEnd.valueOf() + 10 * 60000),
    }),
  ).toEqual({ kind: "conflict" });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [f.budgetId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 20, consumed: 0 }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
        [f.allocationId],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

it("serves an exact-granted content-free operator workflow and reloads the settled member receipt", async () => {
  const f = await fixture(),
    time = support.time!,
    origin = "http://127.0.0.1:3000",
    secret = "invented-support-time-operator-http";
  const granted = await time.grant(f.adminToken, {
    requestId: f.requestId,
    allocationId: f.allocationId,
    staffId: f.operatorId,
    role: "operator",
    idempotencyKey: randomUUID(),
    startsAt: f.startsAt,
    expiresAt: f.expiresAt,
  });
  if (!("grantId" in granted)) throw Error("Missing time grant");
  const server = await listenLoopback(
    app(members, { origin, secret, supportRequests: support }),
  );
  const href = `/operator/support-time/${f.requestId}?allocation=${f.allocationId}&grant=${granted.grantId}`;
  const get = (path: string, token = f.operatorToken) =>
    request(server)
      .get(path)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${token}`);
  const post = (action: string, fields: Record<string, string>) =>
    request(server)
      .post(`/operator/support-time/${f.requestId}/${action}`)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${f.operatorToken}`)
      .type("form")
      .send(fields);
  try {
    const list = await get("/operator/support-time").expect(200);
    expect(list.text).toContain("Private support test effort");
    expect(list.text).not.toContain("Private sample, no real service");
    await get(href, f.token).expect(403);
    const opened = await get(href).expect(200);
    expect(opened.text).toContain("Begin support test effort");
    expect(opened.text).not.toContain("Record and settle test effort");
    const common = {
      csrf: csrf(f.operatorToken, secret),
      allocationId: f.allocationId,
      grantId: granted.grantId,
      idempotencyKey: randomUUID(),
      confirm: "yes",
    };
    const begin = await post("begin", common).expect(303);
    expect(begin.headers.location).toBe(href);
    const active = await get(href).expect(200);
    expect(active.text).toContain("Record and settle test effort");
    const segments = intervals(new Date(Date.now() - 3600000));
    const body = {
      ...common,
      idempotencyKey: randomUUID(),
      supportStart: segments.supportStart.toISOString(),
      supportEnd: segments.supportEnd.toISOString(),
      preparationStart: segments.preparationStart.toISOString(),
      preparationEnd: segments.preparationEnd.toISOString(),
    };
    await post("record", { ...body, supportStart: "not UTC" }).expect(422);
    const record = await post("record", body).expect(303);
    expect(record.headers.location).toBe(href);
    await post("record", body).expect(303);
    const done = await get(href).expect(200);
    expect(done.headers["cache-control"]).toContain("no-store");
    expect(done.text).toContain("Consumed: 15. Released: 5.");
    expect(done.text).not.toContain("Record and settle test effort");
    const owner = await get(`/support/${f.requestId}`, f.token).expect(200);
    expect(owner.text).toContain("Consumed: 15. Released: 5.");
    expect(owner.text).not.toContain(granted.grantId);
    expect(owner.text).not.toContain(f.operatorId);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
          [f.allocationId],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  } finally {
    await closeLoopback(server);
  }
});

it("serializes the same operator across different members, rejecting overlap while permitting adjacent intervals", async () => {
  const f = await fixture(),
    first = await begun(f),
    time = support.time!,
    secondToken = randomBytes(32).toString("hex");
  await members.create(secondToken, { background: "technical", goal: "build" });
  const secondMember = await members.session(secondToken);
  if (secondMember.kind !== "active")
    throw Error("Missing second invented owner");
  const secondBudget = await ledger.grant(
    secondMember.learner.id,
    "support_minutes",
    20,
    randomUUID(),
    {
      startsAt: f.startsAt.toISOString(),
      expiresAt: f.expiresAt.toISOString(),
    },
  );
  const intake = await support.create(secondToken, {
    idempotencyKey: randomUUID(),
    subject: "Another invented request",
    body: "Private second owner sample",
  });
  if (!("receipt" in intake)) throw Error("Missing second request");
  const held = await time.allocate(
    secondToken,
    intake.receipt.requestId,
    randomUUID(),
    20,
  );
  if (!("receipt" in held)) throw Error("Missing second allocation");
  const granted = await time.grant(f.adminToken, {
    requestId: intake.receipt.requestId,
    allocationId: held.receipt.allocationId,
    staffId: f.operatorId,
    role: "operator",
    idempotencyKey: randomUUID(),
    startsAt: f.startsAt,
    expiresAt: f.expiresAt,
  });
  if (!("grantId" in granted)) throw Error("Missing second time grant");
  const second = {
    requestId: intake.receipt.requestId,
    allocationId: held.receipt.allocationId,
    grantId: granted.grantId,
  };
  expect((await time.begin(f.operatorToken, second, randomUUID())).kind).toBe(
    "applied",
  );
  const segments = intervals(new Date(Date.now() - 3600000)),
    scopes = [first, second];
  const results = await Promise.all(
    scopes.map((scope) =>
      time.record(f.operatorToken, scope, randomUUID(), segments),
    ),
  );
  expect(results.map((r) => r.kind).sort()).toEqual(["applied", "conflict"]);
  const loser = results.findIndex((r) => r.kind === "conflict");
  const adjacent = intervals(segments.preparationEnd);
  expect(
    await time.record(f.operatorToken, scopes[loser]!, randomUUID(), adjacent),
  ).toMatchObject({ kind: "applied", receipt: { consumed: 15, released: 5 } });
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_entries WHERE actor_id=$1",
        [f.operatorId],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
  await members.remove(f.memberId);
  expect(await time.receipt(secondToken, second.requestId)).toMatchObject({
    kind: "ready",
    value: { state: "completed", consumed: 15, released: 5 },
  });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [secondBudget],
      )
    ).rows,
  ).toEqual([{ available: 5, reserved: 0, consumed: 15 }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_entries WHERE allocation_id=$1",
        [second.allocationId],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
});

it("reconciles each support entry once and each consumed unit as one typed attachment", async () => {
  const f = await fixture(),
    scope = await begun(f);
  expect(
    (
      await support.time!.record(
        f.operatorToken,
        scope,
        randomUUID(),
        intervals(new Date(Date.now() - 3600000)),
      )
    ).kind,
  ).toBe("applied");
  const result = await ledgerReconciliationStore(pool).snapshot(
    f.operatorToken,
  );
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Missing structural snapshot");
  const supportRow = result.value.categories.find(
    (c) => c.category === "support_minutes",
  );
  expect(supportRow).toMatchObject({
    observed: {
      grants: 1,
      reservations: 20,
      events: 41,
      completions: 1,
      available: 5,
      reserved: 0,
      consumed: 15,
    },
    completion: {
      attachedQuantity: 15,
      deliveredMinutes: 10,
      preparationMinutes: 5,
      consumedWithoutAttachment: 0,
    },
    reconciliation: {
      status: "consistent",
      grants: 0,
      reservations: 0,
      events: 0,
      completions: 0,
    },
  });
  const reservation = await ledger.reserve(
    f.memberId,
    f.budgetId,
    2,
    randomUUID(),
  );
  await ledger.settleCompletion(f.memberId, reservation, randomUUID(), {
    reference: "synthetic:invented-formal-support",
    category: "support_minutes",
    deliveredMinutes: 1,
    preparationMinutes: 1,
  });
  const mixed = await ledgerReconciliationStore(pool).snapshot(f.operatorToken);
  if (mixed.kind !== "ready") throw Error("Missing mixed structural snapshot");
  expect(
    mixed.value.categories.find((c) => c.category === "support_minutes"),
  ).toMatchObject({
    observed: { completions: 2, consumed: 17, available: 3 },
    completion: {
      attachedQuantity: 17,
      deliveredMinutes: 11,
      preparationMinutes: 6,
      consumedWithoutAttachment: 0,
    },
    reconciliation: { status: "consistent" },
  });
  const unit = (
    await pool.query<{ id: string }>(
      "SELECT reservation_id AS id FROM support_time_units WHERE allocation_id=$1 AND ordinal=1",
      [f.allocationId],
    )
  ).rows[0]!;
  await pool.query(
    "INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id) VALUES($1,$2,$3,$4,'consume',1,$5,$6,$4)",
    [
      randomUUID(),
      f.memberId,
      f.budgetId,
      unit.id,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  const damaged = await ledgerReconciliationStore(pool).snapshot(
    f.operatorToken,
  );
  if (damaged.kind !== "ready")
    throw Error("Missing damaged structural snapshot");
  expect(
    damaged.value.categories.find((c) => c.category === "support_minutes"),
  ).toMatchObject({
    observed: { completions: 2, consumed: 17 },
    reconciliation: {
      status: "discrepancies",
      reservations: 1,
      completions: 1,
    },
  });
});

it("exports only owned support allocation and interval facts without accounting keys, grants, staff identities or notes", async () => {
  const f = await fixture(),
    scope = await begun(f);
  expect(
    (
      await support.time!.record(
        f.operatorToken,
        scope,
        randomUUID(),
        intervals(new Date(Date.now() - 3600000)),
      )
    ).kind,
  ).toBe("applied");
  const other = await fixture(),
    otherScope = await begun(other);
  expect(
    (
      await support.time!.record(
        other.operatorToken,
        otherScope,
        randomUUID(),
        intervals(new Date(Date.now() - 3600000)),
      )
    ).kind,
  ).toBe("applied");
  const noteGrant = await support.grant(f.adminToken, {
    requestId: f.requestId,
    staffId: f.operatorId,
    role: "operator",
    idempotencyKey: randomUUID(),
    startsAt: f.startsAt,
    expiresAt: f.expiresAt,
  });
  if (!("grantId" in noteGrant)) throw Error("Missing separate note grant");
  expect(
    (
      await support.note(
        f.operatorToken,
        { requestId: f.requestId, grantId: noteGrant.grantId },
        randomUUID(),
        "INTERNAL-TIME-NOTE-NEVER-EXPORT",
      )
    ).kind,
  ).toBe("applied");
  const result = await memberExportStore(pool).exportOwned(f.token);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Missing owned export");
  expect(result.payload.records.supportTimeAllocations).toHaveLength(1);
  expect(result.payload.records.supportTimeEntries).toHaveLength(1);
  expect(result.payload.records.supportTimeAllocations![0]).toMatchObject({
    id: f.allocationId,
    requestId: f.requestId,
    ceiling: 20,
    state: "completed",
    held: 0,
    consumed: 15,
    released: 5,
  });
  expect(result.payload.records.supportTimeEntries![0]).toMatchObject({
    allocationId: f.allocationId,
    requestId: f.requestId,
    supportMinutes: 10,
    preparationMinutes: 5,
    attribution: "Synthetic operator",
  });
  const raw =
    JSON.stringify(result.payload.records.supportTimeAllocations) +
    JSON.stringify(result.payload.records.supportTimeEntries);
  for (const value of [
    scope.grantId,
    f.operatorId,
    f.budgetId,
    "idempotency",
    "fingerprint",
    "reservationId",
    "actorId",
    other.allocationId,
    other.requestId,
    other.budgetId,
    other.operatorId,
  ])
    expect(raw).not.toContain(value);
  expect(JSON.stringify(result.payload)).not.toContain("INTERNAL-TIME-NOTE");
  expect(
    Object.keys(result.payload.records.supportTimeEntries![0]!).sort(),
  ).toEqual(
    [
      "allocationId",
      "requestId",
      "supportStart",
      "supportEnd",
      "preparationStart",
      "preparationEnd",
      "supportMinutes",
      "preparationMinutes",
      "createdAt",
      "attribution",
    ].sort(),
  );
  expect(
    Object.keys(result.payload.records.supportTimeAllocations![0]!).sort(),
  ).toEqual(
    [
      "id",
      "requestId",
      "policy",
      "ceiling",
      "state",
      "createdAt",
      "begunAt",
      "settledAt",
      "attribution",
      "held",
      "consumed",
      "released",
    ].sort(),
  );
  await support.withdraw(f.token, f.requestId);
  const redacted = await memberExportStore(pool).exportOwned(f.token);
  if (redacted.kind !== "ready") throw Error("Missing redacted export");
  expect(redacted.payload.records.supportRequests![0]).toMatchObject({
    body: null,
    subject: null,
    state: "withdrawn",
  });
  expect(redacted.payload.records.supportTimeEntries).toHaveLength(1);
  await members.remove(f.memberId);
  expect(await memberExportStore(pool).exportOwned(f.token)).toEqual({
    kind: "denied",
  });
  const retained = await memberExportStore(pool).exportOwned(other.token);
  if (retained.kind !== "ready")
    throw Error("Missing retained other-owner export");
  expect(retained.payload.records.supportTimeEntries).toHaveLength(1);
  expect(retained.payload.records.supportTimeAllocations![0]).toMatchObject({
    id: other.allocationId,
    consumed: 15,
    released: 5,
  });
});

it("paginates more than one hundred owned allocations without duplicates, foreign rows or unbounded pages", async () => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const member = await members.session(token);
  if (member.kind !== "active") throw Error("Missing invented member");
  await ledger.grant(member.learner.id, "support_minutes", 120, randomUUID(), {
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const expected: string[] = [];
  for (let i = 0; i < 101; i++) {
    const intake = await support.create(token, {
      idempotencyKey: randomUUID(),
      subject: `Invented export ${i}`,
      body: "Bounded private test",
    });
    if (!("receipt" in intake)) throw Error("Missing request");
    const allocated = await support.time!.allocate(
      token,
      intake.receipt.requestId,
      randomUUID(),
      1,
    );
    if (!("receipt" in allocated)) throw Error("Missing hold");
    expected.push(allocated.receipt.allocationId);
  }
  const exporter = memberExportStore(pool),
    actual: string[] = [];
  let cursor: string | undefined,
    pages = 0;
  do {
    const result = await exporter.exportOwned(token, cursor);
    if (result.kind !== "ready") throw Error("Missing bounded export page");
    expect(result.payload.page.recordCount).toBeLessThanOrEqual(100);
    expect(
      Buffer.byteLength(JSON.stringify(result.payload)),
    ).toBeLessThanOrEqual(256 * 1024);
    actual.push(
      ...result.payload.records.supportTimeAllocations!.map((r) =>
        String(r.id),
      ),
    );
    cursor = result.payload.page.nextCursor ?? undefined;
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(actual.sort()).toEqual(expected.sort());
  expect(new Set(actual).size).toBe(101);
}, 20000);

it("cancels unstarted held minutes once and offers fresh explicit confirmation for a replacement allocation", async () => {
  const f = await fixture(),
    origin = "http://127.0.0.1:3000",
    secret = "invented-support-time-cancel";
  const server = await listenLoopback(
    app(members, { origin, secret, supportRequests: support }),
  );
  const path = `/support/${f.requestId}/time/${f.allocationId}/cancel`;
  const post = (path: string, fields: Record<string, string>) =>
    request(server)
      .post(path)
      .set("Host", "127.0.0.1:3000")
      .set("Origin", origin)
      .set("Cookie", `${COOKIE}=${f.token}`)
      .type("form")
      .send(fields);
  try {
    await post(path, { csrf: csrf(f.token, secret), confirm: "yes" }).expect(
      303,
    );
    await post(path, { csrf: csrf(f.token, secret), confirm: "yes" }).expect(
      303,
    );
    expect(await support.time!.receipt(f.token, f.requestId)).toMatchObject({
      kind: "ready",
      value: { state: "cancelled", held: 0, released: 20, consumed: 0 },
    });
    const page = await request(server)
      .get(`/support/${f.requestId}`)
      .set("Host", "127.0.0.1:3000")
      .set("Cookie", `${COOKIE}=${f.token}`)
      .expect(200);
    expect(page.text).toContain("Hold support test minutes");
    expect(page.text).toContain("State: cancelled.");
    const key = randomUUID();
    await post(`/support/${f.requestId}/time/allocate`, {
      csrf: csrf(f.token, secret),
      confirm: "yes",
      ceiling: "20",
      idempotencyKey: key,
    }).expect(303);
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM support_time_allocations WHERE request_id=$1",
          [f.requestId],
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
    expect(
      (
        await pool.query(
          "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
          [f.budgetId],
        )
      ).rows,
    ).toEqual([{ available: 0, reserved: 20, consumed: 0 }]);
  } finally {
    await closeLoopback(server);
  }
});

it("pauses support-time writes for rollback while preserving current receipts and unresolved holds", async () => {
  const f = await fixture(),
    scope = await begun(f),
    paused = supportRequestStore(pool, undefined, { timeWrites: false }),
    time = paused.time!;
  expect(time.writesEnabled).toBe(false);
  expect(
    await time.record(
      f.operatorToken,
      scope,
      randomUUID(),
      intervals(new Date(Date.now() - 3600000)),
    ),
  ).toEqual({ kind: "denied" });
  expect(await time.begin(f.operatorToken, scope, randomUUID())).toEqual({
    kind: "denied",
  });
  expect(await time.cancel(f.token, f.requestId, f.allocationId)).toEqual({
    kind: "denied",
  });
  expect(await time.allocate(f.token, f.requestId, randomUUID(), 1)).toEqual({
    kind: "denied",
  });
  expect(
    await time.grant(f.adminToken, {
      requestId: f.requestId,
      allocationId: f.allocationId,
      staffId: f.operatorId,
      role: "operator",
      idempotencyKey: randomUUID(),
      startsAt: f.startsAt,
      expiresAt: f.expiresAt,
    }),
  ).toEqual({ kind: "denied" });
  expect(await time.revoke(f.adminToken, scope.grantId)).toEqual({
    kind: "denied",
  });
  expect(await time.operatorDetail(f.operatorToken, scope)).toMatchObject({
    kind: "ready",
    value: { canBegin: false, canRecord: false, state: "begun", held: 20 },
  });
  expect(await time.receipt(f.token, f.requestId)).toMatchObject({
    kind: "ready",
    value: { state: "begun", held: 20, consumed: 0, released: 0 },
  });
  expect(await paused.withdraw(f.token, f.requestId)).toEqual({
    kind: "withdrawn",
  });
  expect(await time.receipt(f.token, f.requestId)).toMatchObject({
    kind: "ready",
    value: { state: "needs_reconciliation", held: 20 },
  });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [f.budgetId],
      )
    ).rows,
  ).toEqual([{ available: 0, reserved: 20, consumed: 0 }]);
});

it("selects one sufficient earliest-expiring grant with stable ties and never pools smaller grants", async () => {
  const f = await fixture();
  await support.time!.cancel(f.token, f.requestId, f.allocationId);
  const expiresAt = new Date(Date.now() + 1800000).toISOString();
  const first = await ledger.grant(
    f.memberId,
    "support_minutes",
    120,
    randomUUID(),
    {
      startsAt: f.startsAt.toISOString(),
      expiresAt,
    },
  );
  const second = await ledger.grant(
    f.memberId,
    "support_minutes",
    120,
    randomUUID(),
    {
      startsAt: f.startsAt.toISOString(),
      expiresAt,
    },
  );
  await ledger.grant(f.memberId, "support_minutes", 100, randomUUID(), {
    startsAt: f.startsAt.toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  await ledger.grant(f.memberId, "support_minutes", 120, randomUUID(), {
    startsAt: f.startsAt.toISOString(),
    expiresAt: new Date(Date.now() + 2700000).toISOString(),
  });
  const held = await support.time!.allocate(
    f.token,
    f.requestId,
    randomUUID(),
    120,
  );
  expect(held.kind).toBe("applied");
  if (!("receipt" in held)) throw Error("Missing saved allocation");
  expect(
    (
      await pool.query(
        "SELECT grant_id FROM support_time_allocations WHERE id=$1",
        [held.receipt.allocationId],
      )
    ).rows,
  ).toEqual([{ grant_id: [first, second].sort()[0] }]);
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const member = await members.session(token);
  if (member.kind !== "active") throw Error("Missing invented member");
  for (let i = 0; i < 2; i++)
    await ledger.grant(member.learner.id, "support_minutes", 60, randomUUID(), {
      startsAt: f.startsAt.toISOString(),
      expiresAt,
    });
  const created = await support.create(token, {
    idempotencyKey: randomUUID(),
    subject: "No pooled allowance",
    body: "Invented sample",
  });
  if (!("receipt" in created)) throw Error("Missing request");
  expect(
    await support.time!.allocate(
      token,
      created.receipt.requestId,
      randomUUID(),
      120,
    ),
  ).toEqual({ kind: "insufficient" });
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE member_id=$1 ORDER BY id",
        [member.learner.id],
      )
    ).rows,
  ).toEqual([
    { available: 60, reserved: 0, consumed: 0 },
    { available: 60, reserved: 0, consumed: 0 },
  ]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_allocations WHERE member_id=$1",
        [member.learner.id],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

it("rolls back the entire maximum allocation after a real mid-unit query failure without leaking holds or history", async () => {
  const f = await fixture();
  await support.time!.cancel(f.token, f.requestId, f.allocationId);
  const budgetId = await ledger.grant(
    f.memberId,
    "support_minutes",
    120,
    randomUUID(),
    {
      startsAt: f.startsAt.toISOString(),
      expiresAt: f.expiresAt.toISOString(),
    },
  );
  let inserted = 0;
  const calls: string[] = [];
  const failing = supportRequestStore({
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql: string, values?: unknown[]) {
          calls.push(sql);
          const result = await client.query(sql, values);
          if (
            sql.startsWith("INSERT INTO support_time_units") &&
            ++inserted === 60
          )
            throw Error("Invented failure after sixtieth unit");
          return result;
        },
        release(error?: Error) {
          client.release(error);
        },
      };
    },
  } as unknown as Pool);
  expect(
    await failing.time!.allocate(f.token, f.requestId, randomUUID(), 120),
  ).toEqual({ kind: "unavailable" });
  expect(inserted).toBe(60);
  expect(calls.filter((sql) => sql === "COMMIT")).toHaveLength(0);
  expect(calls.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
  expect(
    (
      await pool.query(
        "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
        [budgetId],
      )
    ).rows,
  ).toEqual([{ available: 120, reserved: 0, consumed: 0 }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM synthetic_entitlement_reservations WHERE grant_id=$1",
        [budgetId],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
  expect(
    (
      await pool.query(
        "SELECT operation,count(*)::integer n FROM synthetic_entitlement_events WHERE grant_id=$1 GROUP BY operation",
        [budgetId],
      )
    ).rows,
  ).toEqual([{ operation: "grant", n: 1 }]);
  expect(
    (
      await pool.query(
        "SELECT id,state FROM support_time_allocations WHERE request_id=$1",
        [f.requestId],
      )
    ).rows,
  ).toEqual([{ id: f.allocationId, state: "cancelled" }]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM support_time_events WHERE allocation_id<>$1",
        [f.allocationId],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});
