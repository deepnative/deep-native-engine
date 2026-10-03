import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { supportRequestStore } from "../../src/support-requests.ts";
import {
  supportOperatorDetailPage,
  supportOperatorWorklistPage,
} from "../../src/support-request-views.ts";
import { testPool } from "../support/database.ts";
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  support = supportRequestStore(pool),
  ledger = syntheticLedger(pool);
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
});
afterAll(async () => pool.end());
async function fixture() {
  const token = randomBytes(32).toString("hex"),
    admin = randomBytes(32).toString("hex"),
    operator = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  const member = await members.session(token);
  if (member.kind !== "active") throw Error("Missing invented member");
  const startsAt = new Date(Date.now() - 60000),
    expiresAt = new Date(Date.now() + 3600000);
  await auth.provisionStaff(admin, "platform_admin", expiresAt);
  const staffId = await auth.provisionStaff(operator, "operator", expiresAt);
  const created = await support.create(token, {
    idempotencyKey: randomUUID(),
    subject: "Invented <question>",
    body: "Invented private request body",
  });
  if (!("receipt" in created)) throw Error("Missing request");
  const requestId = created.receipt.requestId;
  const grant = await support.grant(admin, {
    idempotencyKey: randomUUID(),
    requestId,
    staffId,
    role: "operator",
    startsAt,
    expiresAt,
  });
  if (!("grantId" in grant)) throw Error("Missing request grant");
  await ledger.grant(member.learner.id, "support_minutes", 120, randomUUID(), {
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const allocation = await support.time!.allocate(
    token,
    requestId,
    randomUUID(),
    120,
  );
  if (!("receipt" in allocation)) throw Error("Missing allocation");
  const scope = { requestId, grantId: grant.grantId },
    allocationId = allocation.receipt.allocationId;
  return {
    token,
    admin,
    operator,
    staffId,
    memberId: member.learner.id,
    startsAt,
    expiresAt,
    scope,
    allocationId,
  };
}
const keys = {
  acknowledge: "ack",
  reply: "reply",
  note: "note",
  resolve: "resolve",
};
it("shows observed calendar age and current request scope without exposing ungranted effort", async () => {
  const f = await fixture();
  const result = await support.operatorDetail(f.operator, f.scope);
  expect(result).toMatchObject({
    kind: "ready",
    value: {
      operatorContext: {
        grantStartsAt: f.startsAt,
        grantExpiresAt: f.expiresAt,
        allowedActions: ["acknowledge", "note", "reply", "resolve"],
      },
    },
  });
  if (result.kind !== "ready") throw Error("Missing granted detail");
  const value = result.value as typeof result.value & {
    operatorContext: { observedAt: Date; elapsedSeconds: number };
  };
  expect(value.operatorContext.elapsedSeconds).toBe(
    Math.max(
      0,
      Math.floor(
        (value.operatorContext.observedAt.valueOf() -
          value.receivedAt.valueOf()) /
          1000,
      ),
    ),
  );
  expect(value).not.toHaveProperty("authorizedEffort");
  const html = supportOperatorDetailPage(result.value, "csrf", keys);
  expect(html).toContain("Elapsed calendar time");
  expect(html).toContain("No separately authorized test effort shown");
  expect(html).not.toContain(f.allocationId);
  expect(html).not.toContain("120 support test minutes");
});
it("connects one exact separately granted receipt without allocating, beginning or posting work", async () => {
  const f = await fixture();
  const g = await support.time!.grant(f.admin, {
    ...f.scope,
    allocationId: f.allocationId,
    staffId: f.staffId,
    role: "operator",
    startsAt: f.startsAt,
    expiresAt: f.expiresAt,
    idempotencyKey: randomUUID(),
  });
  if (!("grantId" in g)) throw Error("Missing separate time grant");
  const counts = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*)::integer FROM support_time_events) events,(SELECT count(*)::integer FROM support_time_allocations) allocations,(SELECT count(*)::integer FROM support_time_entries) entries,(SELECT count(*)::integer FROM support_request_mutations) mutations,(SELECT count(*)::integer FROM synthetic_entitlement_events) ledger",
      )
    ).rows;
  const before = await counts();
  for (let n = 0; n < 2; n++) {
    const detail = await support.operatorDetail(f.operator, f.scope),
      list = await support.operatorWorklist(f.operator);
    expect(detail).toMatchObject({
      kind: "ready",
      value: {
        authorizedEffort: {
          allocationId: f.allocationId,
          grantId: g.grantId,
          ceiling: 120,
          held: 120,
          consumed: 0,
          released: 0,
          state: "allocated",
        },
      },
    });
    expect(list).toMatchObject({
      kind: "ready",
      value: {
        items: [
          {
            requestId: f.scope.requestId,
            authorizedEffort: {
              allocationId: f.allocationId,
              grantId: g.grantId,
            },
          },
        ],
      },
    });
    if (detail.kind !== "ready" || list.kind !== "ready")
      throw Error("Missing connected read");
    for (const html of [
      supportOperatorDetailPage(detail.value, "csrf", keys),
      supportOperatorWorklistPage(list.value),
    ]) {
      expect(html).toContain(
        `/operator/support-time/${f.scope.requestId}?allocation=${f.allocationId}&amp;grant=${g.grantId}`,
      );
      expect(html).toContain("Allocation-specific test effort");
      expect(html).not.toContain("Begin private support test work");
    }
  }
  expect(await counts()).toEqual(before);
  await support.time!.revoke(f.admin, g.grantId);
  const deniedAssociation = await support.operatorDetail(f.operator, f.scope);
  expect(deniedAssociation.kind).toBe("ready");
  if (deniedAssociation.kind !== "ready")
    throw Error("Missing request-only read");
  expect(deniedAssociation.value).not.toHaveProperty("authorizedEffort");
  expect(
    supportOperatorDetailPage(deniedAssociation.value, "csrf", keys),
  ).toContain("No separately authorized test effort shown");
});
it("retains separately authorized read quantities when time writes are paused", async () => {
  const f = await fixture(),
    paused = supportRequestStore(pool, undefined, { timeWrites: false });
  const g = await support.time!.grant(f.admin, {
    ...f.scope,
    allocationId: f.allocationId,
    staffId: f.staffId,
    role: "operator",
    startsAt: f.startsAt,
    expiresAt: f.expiresAt,
    idempotencyKey: randomUUID(),
  });
  if (!("grantId" in g)) throw Error("Missing separate time grant");
  expect(await paused.operatorDetail(f.operator, f.scope)).toMatchObject({
    kind: "ready",
    value: { authorizedEffort: { held: 120, state: "allocated" } },
  });
  expect(
    await paused.time!.operatorDetail(f.operator, {
      ...f.scope,
      allocationId: f.allocationId,
      grantId: g.grantId,
    }),
  ).toMatchObject({
    kind: "ready",
    value: { held: 120, canBegin: false, canRecord: false },
  });
});

async function timeGrant(f: Awaited<ReturnType<typeof fixture>>) {
  const granted = await support.time!.grant(f.admin, {
    requestId: f.scope.requestId,
    allocationId: f.allocationId,
    staffId: f.staffId,
    role: "operator",
    startsAt: f.startsAt,
    expiresAt: f.expiresAt,
    idempotencyKey: randomUUID(),
  });
  if (!("grantId" in granted)) throw Error("Missing separate time grant");
  return {
    requestId: f.scope.requestId,
    allocationId: f.allocationId,
    grantId: granted.grantId,
  };
}
it("keeps time-only operator receipts content-free and denies member, role-only and foreign request access", async () => {
  const f = await fixture(),
    exact = await timeGrant(f);
  await support.revoke(f.admin, f.scope.grantId);
  expect(await support.operatorDetail(f.operator, f.scope)).toEqual({
    kind: "denied",
  });
  expect(await support.operatorDetail(f.token, f.scope)).toEqual({
    kind: "denied",
  });
  expect(await support.operatorDetail(f.admin, f.scope)).toEqual({
    kind: "denied",
  });
  const time = await support.time!.operatorDetail(f.operator, exact);
  expect(time).toMatchObject({
    kind: "ready",
    value: { allocationId: f.allocationId, held: 120 },
  });
  for (const value of [
    time,
    await support.time!.operatorWorklist(f.operator),
  ]) {
    expect(JSON.stringify(value)).not.toContain("Invented <question>");
    expect(JSON.stringify(value)).not.toContain(
      "Invented private request body",
    );
    expect(JSON.stringify(value)).not.toContain("operatorContext");
  }
});
it("shows current request actions and a single newest grant-specific receipt across terminal allocations", async () => {
  const f = await fixture(),
    first = await timeGrant(f);
  await support.time!.cancel(f.token, f.scope.requestId, f.allocationId);
  const second = await support.time!.allocate(
    f.token,
    f.scope.requestId,
    randomUUID(),
    20,
  );
  if (!("receipt" in second)) throw Error("Missing second allocation");
  const next = await timeGrant({
    ...f,
    allocationId: second.receipt.allocationId,
  });
  const detail = await support.operatorDetail(f.operator, f.scope),
    list = await support.operatorWorklist(f.operator);
  expect(detail).toMatchObject({
    kind: "ready",
    value: {
      authorizedEffort: {
        allocationId: next.allocationId,
        grantId: next.grantId,
        held: 20,
        consumed: 0,
        released: 0,
        ceiling: 20,
      },
    },
  });
  expect(list).toMatchObject({
    kind: "ready",
    value: {
      items: [{ authorizedEffort: { allocationId: next.allocationId } }],
    },
  });
  if (list.kind !== "ready") throw Error("Missing granted list");
  expect(list.value.items).toHaveLength(1);
  expect(JSON.stringify(detail)).not.toContain(first.allocationId);
  await support.acknowledge(f.operator, f.scope, randomUUID());
  expect(await support.operatorDetail(f.operator, f.scope)).toMatchObject({
    kind: "ready",
    value: {
      operatorContext: { allowedActions: ["note", "reply", "resolve"] },
    },
  });
  await support.resolve(f.operator, f.scope, randomUUID());
  const resolved = await support.operatorDetail(f.operator, f.scope);
  expect(resolved).toMatchObject({
    kind: "ready",
    value: { operatorContext: { allowedActions: [] } },
  });
  if (resolved.kind !== "ready") throw Error("Missing resolved receipt");
  const html = supportOperatorDetailPage(resolved.value, "csrf", keys);
  for (const control of [
    "Save internal note",
    "Send member-visible reply",
    "Acknowledge request locally",
    "Resolve request locally",
  ])
    expect(html).not.toContain(control);
});
// This case creates 106 requests and 22 maximum-size allocations through real
// application APIs. Its fixture budget is separate from the unchanged 5s SQL/lock
// and 10s operation deadlines, asserted below on every measured read.
it("keeps more than one hundred request receipts ordered and cursor-bound without effort fanout", async () => {
  const f = await fixture();
  await timeGrant(f);
  const ids = [f.scope.requestId];
  await ledger.grant(f.memberId, "support_minutes", 2520, randomUUID(), {
    startsAt: f.startsAt.toISOString(),
    expiresAt: f.expiresAt.toISOString(),
  });
  for (let n = 0; n < 105; n++) {
    const created = await support.create(f.token, {
      idempotencyKey: randomUUID(),
      subject: `Invented page ${n}`,
      body: "Invented pagination request",
    });
    if (!("receipt" in created)) throw Error("Missing page fixture");
    ids.push(created.receipt.requestId);
    const g = await support.grant(f.admin, {
      requestId: created.receipt.requestId,
      staffId: f.staffId,
      role: "operator",
      startsAt: f.startsAt,
      expiresAt: f.expiresAt,
      idempotencyKey: randomUUID(),
    });
    expect(g.kind).toBe("created");
    if (n >= 84) {
      const allocation = await support.time!.allocate(
        f.token,
        created.receipt.requestId,
        randomUUID(),
        120,
      );
      if (!("receipt" in allocation))
        throw Error("Missing maximum page allocation");
      await timeGrant({
        ...f,
        scope: {
          requestId: created.receipt.requestId,
          grantId: "unused-request-grant",
        },
        allocationId: allocation.receipt.allocationId,
      });
    }
  }
  const measured = controlled(),
    durations: number[] = [];
  const seen: string[] = [];
  let cursor: string | undefined, firstCursor: string | undefined;
  do {
    const started = performance.now();
    const result = await measured.use.operatorWorklist(f.operator, cursor);
    durations.push(performance.now() - started);
    if (result.kind !== "ready") throw Error("Missing bounded page");
    expect(result.value.items.length).toBeLessThanOrEqual(20);
    expect(
      new Set(
        result.value.items.map((r) => r.operatorContext.observedAt.valueOf()),
      ).size,
    ).toBe(1);
    for (const r of result.value.items) {
      seen.push(r.requestId);
      if (r.authorizedEffort) {
        expect(r.authorizedEffort).toMatchObject({
          held: 120,
          ceiling: 120,
          consumed: 0,
          released: 0,
        });
      }
    }
    firstCursor ??= result.value.nextCursor ?? undefined;
    cursor = result.value.nextCursor ?? undefined;
  } while (cursor);
  const ordered = (
    await pool.query(
      "SELECT id FROM support_requests ORDER BY received_at DESC,id DESC",
    )
  ).rows.map((r) => r.id);
  expect(seen).toEqual(ordered);
  expect(new Set(seen).size).toBe(106);
  expect(seen).toHaveLength(ids.length);
  expect(Math.max(...durations)).toBeLessThan(10000);
  const bounded = measured.state.counts.filter(
    (q) => q.sql.includes("WHERE id=ANY") || q.sql.includes("WHERE r.id=ANY"),
  );
  expect(Math.max(...bounded.map((q) => q.ids))).toBeLessThanOrEqual(21);
  expect(
    Math.max(
      ...measured.state.counts
        .filter((q) =>
          q.sql.startsWith('SELECT r.id AS "requestId",r.member_id'),
        )
        .map((q) => q.rows),
    ),
  ).toBe(21);
  const discovery = measured.state.counts.find((q) =>
    q.sql.startsWith('SELECT r.id AS "requestId",selected.id'),
  )!;
  expect(discovery.rows).toBe(21);
  const explain = (
    await pool.query(
      "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT g.id,g.allocation_id FROM support_time_grants g JOIN staff_profiles p ON p.principal_id=g.staff_id AND p.role=g.staff_role WHERE g.request_id=$1 AND g.staff_id=$2 AND g.purpose='support-time-local-v1' AND g.revoked_at IS NULL AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp() ORDER BY g.created_at DESC,g.id DESC LIMIT 1",
      [seen[0], f.staffId],
    )
  ).rows[0]["QUERY PLAN"][0];
  expect(explain.Plan["Actual Rows"]).toBe(1);
  expect(explain["Execution Time"]).toBeLessThan(5000);
  writeFileSync(
    "artifacts/connected-support-bounds.json",
    JSON.stringify(
      {
        scope: "invented-local-connected-support",
        requestRows: 106,
        maximumSelectedCeiling: 120,
        maximumRequestCandidates: 21,
        maximumEffortCandidates: discovery.rows,
        maximumPageMs: Math.max(...durations),
        pages: durations.length,
        explainExecutionMs: explain["Execution Time"],
        plan: explain.Plan,
      },
      null,
      2,
    ),
  );
  expect(firstCursor).toBeDefined();
  expect(
    await support.operatorWorklist(f.operator, firstCursor! + "x"),
  ).toEqual({ kind: "denied" });
  expect(await support.operatorWorklist(f.admin, firstCursor!)).toEqual({
    kind: "denied",
  });
}, 30000);
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(match?: string, failure?: "before" | "after" | "release") {
  const connected = latch(),
    reached = latch(),
    resume = latch(),
    state = {
      pid: 0,
      calls: [] as string[],
      counts: [] as { sql: string; ids: number; rows: number }[],
    };
  const use = supportRequestStore({
    async connect() {
      const client = await pool.connect();
      state.pid = (
        await client.query("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      connected.release();
      let intercepted = false;
      return {
        async query(sql: string, values?: unknown[]) {
          state.calls.push(sql);
          const selected = Boolean(
            match && !intercepted && sql.startsWith(match),
          );
          if (selected) intercepted = true;
          if (selected && failure === "before")
            throw Error("Invented bounded query failure");
          const value = await client.query(sql, values);
          state.counts.push({
            sql,
            ids: Array.isArray(values?.[0]) ? values[0].length : 0,
            rows: value.rows.length,
          });
          if (selected && failure === "after")
            throw Error("Invented lost receipt");
          if (selected && !failure) {
            reached.release();
            await resume.wait;
          }
          return value;
        },
        release(error?: Error) {
          client.release(error);
          if (failure === "release") throw Error("Invented lost handback");
        },
      };
    },
  } as unknown as import("pg").Pool);
  return { use, connected, reached, resume, state };
}
async function blocked(pid: number, by: number) {
  for (let n = 0; n < 200; n++) {
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
  throw Error("Expected PostgreSQL lock wait not observed");
}
it.each(["request", "time"] as const)(
  "withholds a candidate when its %s grant is revoked after discovery",
  async (kind) => {
    const f = await fixture(),
      exact = await timeGrant(f),
      reader = controlled('SELECT r.id AS "requestId",selected.id'),
      pending = reader.use.operatorDetail(f.operator, f.scope);
    try {
      await reader.reached.wait;
      expect(
        await (kind === "request"
          ? support.revoke(f.admin, f.scope.grantId)
          : support.time!.revoke(f.admin, exact.grantId)),
      ).toEqual({ kind: "revoked" });
    } finally {
      reader.resume.release();
    }
    expect(await pending).toEqual({
      kind: kind === "request" ? "denied" : "unavailable",
    });
    expect(
      reader.state.calls.some((sql) => sql.includes("r.subject,r.body")),
    ).toBe(false);
  },
);
it.each(["request", "time"] as const)(
  "holds both permissions through the read before %s revocation can win",
  async (kind) => {
    const f = await fixture(),
      exact = await timeGrant(f),
      reader = controlled("WITH instant AS MATERIALIZED"),
      revoker = controlled(),
      pending = reader.use.operatorDetail(f.operator, f.scope);
    let revoked: Promise<unknown> | undefined;
    try {
      await reader.reached.wait;
      revoked =
        kind === "request"
          ? revoker.use.revoke(f.admin, f.scope.grantId)
          : revoker.use.time!.revoke(f.admin, exact.grantId);
      await revoker.connected.wait;
      await blocked(revoker.state.pid, reader.state.pid);
    } finally {
      reader.resume.release();
    }
    expect(await pending).toMatchObject({
      kind: "ready",
      value: { authorizedEffort: { allocationId: f.allocationId, held: 120 } },
    });
    expect(await revoked).toEqual({ kind: "revoked" });
    const fresh = await support.operatorDetail(f.operator, f.scope);
    if (kind === "request") expect(fresh).toEqual({ kind: "denied" });
    else {
      expect(fresh.kind).toBe("ready");
      if (fresh.kind !== "ready") throw Error("Missing request-only read");
      expect(fresh.value).not.toHaveProperty("authorizedEffort");
    }
  },
);
it.each(["before", "after", "release"] as const)(
  "withholds success after %s COMMIT/handback uncertainty",
  async (failure) => {
    const f = await fixture();
    await timeGrant(f);
    const reader = controlled("COMMIT", failure);
    expect(await reader.use.operatorDetail(f.operator, f.scope)).toEqual({
      kind: "unavailable",
    });
    expect(await support.operatorDetail(f.operator, f.scope)).toMatchObject({
      kind: "ready",
      value: { authorizedEffort: { held: 120, state: "allocated" } },
    });
    expect(
      (await pool.query("SELECT count(*)::integer n FROM support_time_entries"))
        .rows,
    ).toEqual([{ n: 0 }]);
  },
);

it.each([
  "member-revoked",
  "member-expired",
  "actor-revoked",
  "actor-expired",
  "role-changed",
  "workspace-deleting",
] as const)(
  "withholds private data after discovered source becomes %s",
  async (change) => {
    const f = await fixture();
    await timeGrant(f);
    const reader = controlled('SELECT r.id AS "requestId",selected.id'),
      pending = reader.use.operatorDetail(f.operator, f.scope);
    try {
      await reader.reached.wait;
      if (change === "role-changed")
        await pool.query(
          "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
          [f.staffId],
        );
      else if (change === "workspace-deleting")
        await pool.query(
          "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
          [f.memberId],
        );
      else
        await pool.query(
          `UPDATE principals SET ${change.endsWith("revoked") ? "revoked_at=clock_timestamp()" : "expires_at=clock_timestamp()-interval '1 second'"} WHERE id=$1`,
          [change.startsWith("member") ? f.memberId : f.staffId],
        );
    } finally {
      reader.resume.release();
    }
    expect(await pending).toEqual({ kind: "denied" });
    expect(
      reader.state.calls.some((sql) => sql.includes("r.subject,r.body")),
    ).toBe(false);
  },
);
it.each(["withdraw-first", "read-first"] as const)(
  "linearizes request withdrawal in %s order",
  async (order) => {
    const f = await fixture();
    await timeGrant(f);
    const reader = controlled(
        order === "withdraw-first"
          ? 'SELECT r.id AS "requestId",selected.id'
          : "WITH instant AS MATERIALIZED",
      ),
      pending = reader.use.operatorDetail(f.operator, f.scope),
      writer = controlled();
    let withdrawn: Promise<unknown> | undefined;
    try {
      await reader.reached.wait;
      withdrawn = writer.use.withdraw(f.token, f.scope.requestId);
      await writer.connected.wait;
      if (order === "read-first")
        await blocked(writer.state.pid, reader.state.pid);
      else expect(await withdrawn).toEqual({ kind: "withdrawn" });
    } finally {
      reader.resume.release();
    }
    expect(await pending).toMatchObject(
      order === "read-first"
        ? {
            kind: "ready",
            value: {
              body: "Invented private request body",
              authorizedEffort: { held: 120 },
            },
          }
        : { kind: "withdrawn" },
    );
    expect(await withdrawn).toEqual({ kind: "withdrawn" });
    expect(await support.operatorDetail(f.operator, f.scope)).toEqual({
      kind: "withdrawn",
    });
  },
);
it.each(["request", "time", "member", "actor"] as const)(
  "rechecks %s expiry after an actual workspace-row lock wait",
  async (kind) => {
    const f = await fixture(),
      expiresAt = new Date(Date.now() + 1200);
    let scope = f.scope;
    if (kind === "request") {
      const g = await support.grant(f.admin, {
        requestId: f.scope.requestId,
        staffId: f.staffId,
        role: "operator",
        startsAt: f.startsAt,
        expiresAt,
        idempotencyKey: randomUUID(),
      });
      if (!("grantId" in g)) throw Error("Missing short request grant");
      scope = { requestId: f.scope.requestId, grantId: g.grantId };
      await timeGrant(f);
    } else if (kind === "time") await timeGrant({ ...f, expiresAt });
    else {
      await timeGrant(f);
      await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
        kind === "member" ? f.memberId : f.staffId,
        expiresAt,
      ]);
    }
    const blocker = await pool.connect(),
      reader = controlled();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      await blocker.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
        f.memberId,
      ]);
      pending = reader.use.operatorDetail(f.operator, scope);
      await reader.connected.wait;
      await blocked(reader.state.pid, pid);
      let expired = false;
      for (let n = 0; n < 400 && !expired; n++) {
        expired = (
          await pool.query("SELECT clock_timestamp()>$1::timestamptz expired", [
            expiresAt,
          ])
        ).rows[0].expired;
        if (!expired) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(expired).toBe(true);
      await blocker.query("COMMIT");
      expect(await pending).toEqual({ kind: "denied" });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
  },
);
it.each(["begin", "settle", "cancel"] as const)(
  "preserves a consistent effort snapshot before %s acquires its source locks",
  async (action) => {
    const f = await fixture(),
      exact = await timeGrant(f);
    if (action === "settle")
      expect(
        (await support.time!.begin(f.operator, exact, randomUUID())).kind,
      ).toBe("applied");
    const reader = controlled("WITH instant AS MATERIALIZED"),
      writer = controlled(),
      pending = reader.use.operatorDetail(f.operator, f.scope);
    let transition: Promise<unknown> | undefined;
    try {
      await reader.reached.wait;
      const start = new Date(Date.now() - 600000);
      transition =
        action === "begin"
          ? writer.use.time!.begin(f.operator, exact, randomUUID())
          : action === "cancel"
            ? writer.use.time!.cancel(
                f.token,
                f.scope.requestId,
                f.allocationId,
              )
            : writer.use.time!.record(f.operator, exact, randomUUID(), {
                supportStart: start,
                supportEnd: new Date(+start + 5 * 60000),
                preparationStart: null,
                preparationEnd: null,
              });
      await writer.connected.wait;
      await blocked(writer.state.pid, reader.state.pid);
    } finally {
      reader.resume.release();
    }
    expect(await pending).toMatchObject({
      kind: "ready",
      value: {
        authorizedEffort: {
          state: action === "settle" ? "begun" : "allocated",
          held: 120,
          consumed: 0,
          released: 0,
        },
      },
    });
    expect(await transition).toMatchObject({ kind: "applied" });
    expect(await support.operatorDetail(f.operator, f.scope)).toMatchObject({
      kind: "ready",
      value: {
        authorizedEffort:
          action === "begin"
            ? { state: "begun", held: 120 }
            : action === "cancel"
              ? { state: "cancelled", held: 0, released: 120 }
              : { state: "completed", held: 0, consumed: 5, released: 115 },
      },
    });
  },
);

it.each(["erase-first", "read-first"] as const)(
  "linearizes complete member erasure in %s order",
  async (order) => {
    const f = await fixture();
    await timeGrant(f);
    const reader = controlled(
      order === "erase-first"
        ? 'SELECT r.id AS "requestId",selected.id'
        : "WITH instant AS MATERIALIZED",
    );
    const pending = reader.use.operatorDetail(f.operator, f.scope);
    const eraser = await pool.connect();
    let erased: Promise<unknown> | undefined;
    try {
      await reader.reached.wait;
      const pid = (await eraser.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      // This is the same atomic principal deletion used by store.remove; its
      // cascades remove the workspace, request, both grants and allocation.
      erased = eraser.query(
        "DELETE FROM principals WHERE id=$1 AND kind='member'",
        [f.memberId],
      );
      if (order === "read-first") await blocked(pid, reader.state.pid);
      else await erased;
    } finally {
      reader.resume.release();
    }
    try {
      expect(await pending).toMatchObject(
        order === "read-first"
          ? {
              kind: "ready",
              value: {
                body: "Invented private request body",
                authorizedEffort: { held: 120 },
              },
            }
          : { kind: "denied" },
      );
      await erased;
      expect(await support.operatorDetail(f.operator, f.scope)).toEqual({
        kind: "denied",
      });
      expect(
        (await pool.query("SELECT count(*)::integer n FROM support_requests"))
          .rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM support_time_allocations",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      eraser.release();
    }
  },
);

it.each(["member-revoked", "role-changed", "workspace-deleting"] as const)(
  "holds the source through a read before %s can commit",
  async (change) => {
    const f = await fixture();
    await timeGrant(f);
    const reader = controlled("WITH instant AS MATERIALIZED");
    const pending = reader.use.operatorDetail(f.operator, f.scope);
    const writer = await pool.connect();
    let changed: Promise<unknown> | undefined;
    try {
      await reader.reached.wait;
      const pid = (await writer.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      changed =
        change === "member-revoked"
          ? writer.query(
              "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
              [f.memberId],
            )
          : change === "role-changed"
            ? writer.query(
                "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
                [f.staffId],
              )
            : writer.query(
                "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE id=$1",
                [f.memberId],
              );
      await blocked(pid, reader.state.pid);
    } finally {
      reader.resume.release();
    }
    try {
      expect(await pending).toMatchObject({
        kind: "ready",
        value: { authorizedEffort: { held: 120 } },
      });
      await changed;
      expect(await support.operatorDetail(f.operator, f.scope)).toEqual({
        kind: "denied",
      });
    } finally {
      writer.release();
    }
  },
);

it.each(["begin", "settle", "cancel"] as const)(
  "observes the committed effort when %s wins before source locks",
  async (action) => {
    const f = await fixture(),
      exact = await timeGrant(f);
    if (action === "settle")
      expect(
        (await support.time!.begin(f.operator, exact, randomUUID())).kind,
      ).toBe("applied");
    const reader = controlled('SELECT r.id AS "requestId",selected.id');
    const pending = reader.use.operatorDetail(f.operator, f.scope);
    try {
      await reader.reached.wait;
      const start = new Date(Date.now() - 600000);
      const transition =
        action === "begin"
          ? await support.time!.begin(f.operator, exact, randomUUID())
          : action === "cancel"
            ? await support.time!.cancel(
                f.token,
                f.scope.requestId,
                f.allocationId,
              )
            : await support.time!.record(f.operator, exact, randomUUID(), {
                supportStart: start,
                supportEnd: new Date(+start + 5 * 60000),
                preparationStart: null,
                preparationEnd: null,
              });
      expect(transition).toMatchObject({ kind: "applied" });
    } finally {
      reader.resume.release();
    }
    expect(await pending).toMatchObject({
      kind: "ready",
      value: {
        authorizedEffort:
          action === "begin"
            ? { state: "begun", held: 120, consumed: 0, released: 0 }
            : action === "cancel"
              ? { state: "cancelled", held: 0, consumed: 0, released: 120 }
              : { state: "completed", held: 0, consumed: 5, released: 115 },
      },
    });
  },
);

it.each(["expired", "not-started", "foreign", "revoked"] as const)(
  "uses the same request-only state when optional effort authority is %s",
  async (condition) => {
    const f = await fixture(),
      exact = await timeGrant(f);
    expect(await support.time!.revoke(f.admin, exact.grantId)).toEqual({
      kind: "revoked",
    });
    if (condition !== "revoked") {
      const now = new Date(),
        startsAt =
          condition === "not-started"
            ? new Date(+now + 60000)
            : new Date(+now - 120000),
        expiresAt =
          condition === "expired"
            ? new Date(+now - 60000)
            : new Date(+now + 120000);
      const staffId =
        condition === "foreign"
          ? await auth.provisionStaff(
              randomBytes(32).toString("hex"),
              "operator",
              f.expiresAt,
            )
          : f.staffId;
      await pool.query(
        "INSERT INTO support_time_grants(id,allocation_id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key) SELECT $2,allocation_id,request_id,$3,staff_role,$4,$5,granted_by,$6 FROM support_time_grants WHERE id=$1",
        [
          exact.grantId,
          randomUUID(),
          staffId,
          startsAt,
          expiresAt,
          randomUUID(),
        ],
      );
    }
    const detail = await support.operatorDetail(f.operator, f.scope),
      list = await support.operatorWorklist(f.operator);
    expect(detail.kind).toBe("ready");
    expect(list.kind).toBe("ready");
    if (detail.kind !== "ready" || list.kind !== "ready")
      throw Error("Missing request-only receipt");
    for (const value of [detail.value, ...list.value.items])
      expect(value).not.toHaveProperty("authorizedEffort");
    const html = supportOperatorDetailPage(detail.value, "csrf", keys);
    expect(html).toContain("No separately authorized test effort shown");
    expect(html).not.toContain(f.allocationId);
    expect(html).not.toContain(exact.grantId);
  },
);
it("breaks equal time-grant creation instants by descending identifier without allocation aggregation", async () => {
  const f = await fixture(),
    first = await timeGrant(f);
  expect(
    (await support.time!.cancel(f.token, f.scope.requestId, f.allocationId))
      .kind,
  ).toBe("applied");
  const second = await support.time!.allocate(
    f.token,
    f.scope.requestId,
    randomUUID(),
    20,
  );
  if (!("receipt" in second)) throw Error("Missing second allocation");
  const next = await timeGrant({
    ...f,
    allocationId: second.receipt.allocationId,
  });
  const tiedAt = (await pool.query("SELECT clock_timestamp() at")).rows[0].at;
  const pairs = [
    {
      id: randomUUID(),
      source: first.grantId,
      allocationId: first.allocationId,
      held: 0,
      released: 120,
    },
    {
      id: randomUUID(),
      source: next.grantId,
      allocationId: next.allocationId,
      held: 20,
      released: 0,
    },
  ];
  for (const pair of pairs)
    await pool.query(
      "INSERT INTO support_time_grants(id,allocation_id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,idempotency_key,created_at) SELECT $2,allocation_id,request_id,staff_id,staff_role,starts_at,expires_at,granted_by,$3,$4 FROM support_time_grants WHERE id=$1",
      [pair.source, pair.id, randomUUID(), tiedAt],
    );
  const winner = pairs.sort((a, b) => b.id.localeCompare(a.id))[0];
  if (!winner) throw Error("Missing tied-grant fixture");
  expect(await support.operatorDetail(f.operator, f.scope)).toMatchObject({
    kind: "ready",
    value: {
      authorizedEffort: {
        grantId: winner.id,
        allocationId: winner.allocationId,
        held: winner.held,
        released: winner.released,
      },
    },
  });
});

it.each(["BEGIN", "COMMIT"])(
  "discards a real PostgreSQL connection when its %s reply is withheld beyond the client deadline",
  async (stage) => {
    const f = await fixture();
    await timeGrant(f);
    const reader = controlled(stage),
      started = performance.now(),
      pending = reader.use.operatorDetail(f.operator, f.scope);
    try {
      await reader.reached.wait;
      expect(await pending).toEqual({ kind: "unavailable" });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      expect(elapsed).toBeLessThan(10000);
      expect(reader.state.calls).not.toContain("ROLLBACK");
      let removed = false;
      for (let n = 0; n < 200 && !removed; n++) {
        removed = !(
          await pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) present",
            [reader.state.pid],
          )
        ).rows[0].present;
        if (!removed) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(removed).toBe(true);
      expect(await support.operatorDetail(f.operator, f.scope)).toMatchObject({
        kind: "ready",
        value: { authorizedEffort: { state: "allocated", held: 120 } },
      });
      expect(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM support_time_entries",
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      reader.resume.release();
      await pending;
    }
  },
  15000,
);
