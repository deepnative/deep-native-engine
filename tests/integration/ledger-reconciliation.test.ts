import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
import { syntheticLedger, type LedgerCategory } from "../../src/ledger.ts";
import {
  ledgerReconciliationStore,
  type LedgerReconciliationSnapshot,
} from "../../src/ledger-reconciliation.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool),
  ledger = syntheticLedger(pool),
  report = ledgerReconciliationStore(pool);
const window = {
  startsAt: "2020-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
};
const categories: LedgerCategory[] = [
  "coach_minutes",
  "review_minutes",
  "support_minutes",
  "mock_sessions",
  "study_requests",
];
const token = () => randomBytes(32).toString("hex");
beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs,principals,cohorts CASCADE"),
);
afterAll(async () => pool.end());
async function member() {
  const value = token();
  await db.create(value, { background: "explorer", goal: "everyday" });
  const session = await db.session(value);
  if (session.kind !== "active") throw Error("Expected member");
  return { token: value, id: session.learner.id };
}
async function staff(
  role: StaffRole = "operator",
  expiresAt = new Date(Date.now() + 3600000),
) {
  const value = token(),
    id = await auth.provisionStaff(value, role, expiresAt);
  return { token: value, id, expiresAt };
}
async function fixture(
  category: LedgerCategory = "review_minutes",
  quantity = 100,
) {
  const owner = await member(),
    operator = await staff(),
    grantId = await ledger.grant(
      owner.id,
      category,
      quantity,
      randomUUID(),
      window,
    );
  return { owner, operator, grantId, category };
}
async function snapshot(value: string): Promise<LedgerReconciliationSnapshot> {
  const result = await report.snapshot(value);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected snapshot");
  return result.value;
}
function category(
  snapshot: LedgerReconciliationSnapshot,
  name: LedgerCategory = "review_minutes",
) {
  const found = snapshot.categories.find((row) => row.category === name);
  if (!found) throw Error("Expected fixed category");
  return found;
}
async function event(
  memberId: string,
  grantId: string,
  operation: string,
  quantity: number,
  reservationId: string | null = null,
  resultId = reservationId ?? grantId,
) {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      memberId,
      grantId,
      reservationId,
      operation,
      quantity,
      randomUUID(),
      "a".repeat(64),
      resultId,
    ],
  );
  return id;
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function controlled(
  match?: string,
  fail?: "before" | "after" | "database",
  gate?: number,
  rollbackFails = false,
) {
  const connected = latch(),
    reached = latch(),
    resume = latch(),
    state = { pid: 0, calls: [] as string[], discarded: false };
  const use = ledgerReconciliationStore({
    async connect() {
      const client = await pool.connect();
      state.pid = (
        await client.query("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      connected.release();
      let once = false;
      return {
        async query(sql: string, values?: unknown[]) {
          state.calls.push(sql);
          if (rollbackFails && sql === "ROLLBACK")
            throw Error("Synthetic rollback failure");
          const selected = !once && match && sql.startsWith(match);
          if (selected) once = true;
          if (selected && fail === "before")
            throw Error("Synthetic query failure");
          if (selected && fail === "database") await client.query("SELECT 1/0");
          // A test-only advisory gate executes inside the report statement. Its
          // snapshot is already established while a separate writer commits.
          const actual =
            gate !== undefined && sql.startsWith("WITH")
              ? `WITH snapshot_gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(${gate})) SELECT report.* FROM (${sql}) report CROSS JOIN snapshot_gate`
              : sql;
          const result = await client.query(actual, values);
          if (selected && fail === "after")
            throw Error("Synthetic lost commit receipt");
          if (selected && !fail) {
            reached.release();
            await resume.wait;
          }
          return result;
        },
        release(error?: Error) {
          state.discarded = Boolean(error);
          client.release(error);
        },
      };
    },
  } as unknown as Pool);
  return { use, connected, reached, resume, state };
}
async function blocked(pid: number, by: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      (
        await pool.query(
          "SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked",
          [by, pid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected actual PostgreSQL lock wait");
}

it("returns five zero categories only for current operators/admins and never identifies members", async () => {
  for (const role of ["operator", "platform_admin"] as const) {
    const actor = await staff(role),
      result = await snapshot(actor.token);
    expect(result.scope).toBe("synthetic-local-preview");
    expect(result.asOf).toBeInstanceOf(Date);
    expect(result.categories.map((r) => r.category)).toEqual(categories);
    for (const row of result.categories) {
      expect(Object.values(row.observed)).toEqual(Array(10).fill(0));
      expect(row.reconciliation.status).toBe("consistent");
    }
    expect(JSON.stringify(result)).not.toContain(actor.id);
  }
  const owner = await member(),
    reviewer = await staff("reviewer");
  for (const value of [owner.token, reviewer.token, token(), "bad"])
    expect(await report.snapshot(value)).toEqual({ kind: "denied" });
  const revoked = await staff(),
    expired = await staff();
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [revoked.id],
  );
  for (const value of [revoked.token, expired.token])
    expect(await report.snapshot(value)).toEqual({ kind: "denied" });
});
it("separates all five units and treats ordinary consumed reservations without attachment as valid", async () => {
  const owner = await member(),
    operator = await staff();
  for (const name of categories) {
    const grant = await ledger.grant(owner.id, name, 100, randomUUID(), window),
      reservation = await ledger.reserve(owner.id, grant, 10, randomUUID());
    const result = await ledger.consume(owner.id, reservation, randomUUID());
    expect(result).toBe(reservation);
  }
  const result = await snapshot(operator.token);
  for (const row of result.categories) {
    expect(row.observed).toEqual({
      grants: 1,
      reservations: 1,
      events: 3,
      completions: 0,
      granted: 100,
      available: 90,
      reserved: 0,
      consumed: 10,
      expired: 0,
      adjusted: 0,
    });
    expect(row.completion).toEqual({
      attachedQuantity: 0,
      deliveredMinutes: 0,
      preparationMinutes: 0,
      consumedWithoutAttachment: 1,
    });
    expect(row.events).toEqual({
      grant: 1,
      reserve: 1,
      consume: 1,
      release: 0,
      expire: 0,
      adjust: 0,
    });
    expect(row.reconciliation).toEqual({
      status: "consistent",
      grants: 0,
      reservations: 0,
      events: 0,
      completions: 0,
    });
  }
});
it("counts preparation-inclusive review/support and one-request attachments once with exact event links", async () => {
  const owner = await member(),
    operator = await staff();
  for (const name of [
    "review_minutes",
    "support_minutes",
    "study_requests",
  ] as const) {
    const amount = name === "study_requests" ? 1 : 30,
      grant = await ledger.grant(owner.id, name, 100, randomUUID(), window),
      reservation = await ledger.reserve(owner.id, grant, amount, randomUUID());
    const attachment =
      name === "study_requests"
        ? {
            reference: `synthetic:${randomUUID()}`,
            category: name,
            quantity: 1 as const,
          }
        : {
            reference: `synthetic:${randomUUID()}`,
            category: name,
            deliveredMinutes: 20,
            preparationMinutes: 10,
          };
    const result = await ledger.settleCompletion(
      owner.id,
      reservation,
      randomUUID(),
      attachment,
    );
    expect(result).not.toBe(reservation);
    const row = category(await snapshot(operator.token), name);
    expect(row.observed.completions).toBe(1);
    expect(row.observed.consumed).toBe(amount);
    expect(row.completion).toEqual({
      attachedQuantity: amount,
      deliveredMinutes: name === "study_requests" ? 0 : 20,
      preparationMinutes: name === "study_requests" ? 0 : 10,
      consumedWithoutAttachment: 0,
    });
    expect(row.reconciliation.status).toBe("consistent");
    expect(JSON.stringify(row)).not.toContain(attachment.reference);
  }
});
it.each(["before-sweep", "after-sweep", "zero-expiry"] as const)(
  "observes %s release/expiry without inventing release bucket attribution",
  async (order) => {
    const f = await fixture(),
      startsAt = "2026-01-01T00:00:00.000Z",
      expiresAt = "2026-01-02T00:00:00.000Z";
    let now = new Date(startsAt);
    const clocked = syntheticLedger(pool, () => now);
    const grant = await clocked.grant(
      f.owner.id,
      "support_minutes",
      100,
      randomUUID(),
      { startsAt, expiresAt },
    );
    await clocked.adjust(f.owner.id, grant, 10, randomUUID());
    const reservation = await clocked.reserve(
      f.owner.id,
      grant,
      order === "zero-expiry" ? 90 : 30,
      randomUUID(),
    );
    now = new Date(expiresAt);
    if (order !== "before-sweep")
      await clocked.expire(f.owner.id, grant, randomUUID());
    await clocked.release(f.owner.id, reservation, randomUUID());
    const before = category(
      await snapshot(f.operator.token),
      "support_minutes",
    );
    expect(before.reconciliation.status).toBe("consistent");
    expect(before.observed.adjusted).toBe(10);
    if (order === "before-sweep") {
      expect(before.observed).toMatchObject({ available: 60, expired: 30 });
      expect(before.events.expire).toBe(0);
      await clocked.expire(f.owner.id, grant, randomUUID());
    }
    const after = category(await snapshot(f.operator.token), "support_minutes");
    expect(after.observed).toMatchObject({
      available: 0,
      reserved: 0,
      expired: 90,
      adjusted: 10,
    });
    expect(after.events).toMatchObject({ expire: 1, release: 1, adjust: 1 });
    expect(after.reconciliation.status).toBe("consistent");
  },
);
it("observes release to available before expiry without treating it as bookable capacity", async () => {
  const f = await fixture(),
    reservation = await ledger.reserve(f.owner.id, f.grantId, 30, randomUUID());
  await ledger.release(f.owner.id, reservation, randomUUID());
  const row = category(await snapshot(f.operator.token));
  expect(row.observed).toMatchObject({
    available: 100,
    reserved: 0,
    expired: 0,
  });
  expect(row.reconciliation.status).toBe("consistent");
});
it("reports missing and duplicated original grant events per grant", async () => {
  const f = await fixture(),
    missing = randomUUID();
  await pool.query(
    "INSERT INTO synthetic_entitlement_grants(id,member_id,category,quantity,available,starts_at,expires_at) VALUES($1,$2,'review_minutes',100,100,$3,$4)",
    [missing, f.owner.id, window.startsAt, window.expiresAt],
  );
  await event(f.owner.id, f.grantId, "grant", 100);
  const row = category(await snapshot(f.operator.token));
  expect(row.observed).toMatchObject({ grants: 2, granted: 200, events: 2 });
  expect(row.reconciliation).toMatchObject({
    status: "discrepancies",
    grants: 2,
  });
});
it.each(["reserved", "consumed", "adjusted"] as const)(
  "cannot cancel opposite %s discrepancies across grants",
  async (bucket) => {
    const f = await fixture(),
      other = await ledger.grant(
        f.owner.id,
        "review_minutes",
        100,
        randomUUID(),
        window,
      );
    for (const grant of [f.grantId, other]) {
      if (bucket === "adjusted")
        await ledger.adjust(f.owner.id, grant, 10, randomUUID());
      else {
        const reservation = await ledger.reserve(
          f.owner.id,
          grant,
          10,
          randomUUID(),
        );
        if (bucket === "consumed")
          await ledger.consume(f.owner.id, reservation, randomUUID());
      }
    }
    await pool.query(
      `UPDATE synthetic_entitlement_grants SET ${bucket}=${bucket}+5,available=available-5 WHERE id=$1`,
      [f.grantId],
    );
    await pool.query(
      `UPDATE synthetic_entitlement_grants SET ${bucket}=${bucket}-5,available=available+5 WHERE id=$1`,
      [other],
    );
    const row = category(await snapshot(f.operator.token));
    expect(row.observed[bucket]).toBe(20);
    expect(row.observed.available).toBe(180);
    expect(row.reconciliation).toMatchObject({
      status: "discrepancies",
      grants: 2,
    });
  },
);
it("detects grant quantity mismatch without exposing event fingerprint or grant/member IDs", async () => {
  const f = await fixture();
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET quantity=110,available=110 WHERE id=$1",
    [f.grantId],
  );
  const result = await snapshot(f.operator.token),
    row = category(result);
  expect(row.reconciliation).toMatchObject({
    status: "discrepancies",
    grants: 1,
    events: 1,
  });
  const raw = JSON.stringify(result);
  for (const privateValue of [
    f.owner.id,
    f.operator.id,
    f.grantId,
    "request_fingerprint",
    "idempotency_key",
    "completion_ref",
  ])
    expect(raw).not.toContain(privateValue);
});
it("detects opposite reservation quantities even when their aggregate quantity is unchanged", async () => {
  const f = await fixture(),
    first = await ledger.reserve(f.owner.id, f.grantId, 10, randomUUID()),
    second = await ledger.reserve(f.owner.id, f.grantId, 10, randomUUID());
  await pool.query(
    "UPDATE synthetic_entitlement_reservations SET quantity=CASE WHEN id=$1 THEN 5 ELSE 15 END WHERE id=ANY($2::uuid[])",
    [first, [first, second]],
  );
  const row = category(await snapshot(f.operator.token));
  expect(row.observed.reserved).toBe(20);
  expect(row.reconciliation).toMatchObject({
    grants: 0,
    reservations: 2,
    events: 2,
    status: "discrepancies",
  });
});
it.each([
  "missing-reserve",
  "duplicate-reserve",
  "consumed-without-event",
  "released-without-event",
  "reserved-with-consume",
])("detects state-incompatible reservation history: %s", async (scenario) => {
  const f = await fixture();
  let reservation: string;
  if (scenario === "missing-reserve") {
    reservation = randomUUID();
    await pool.query(
      "INSERT INTO synthetic_entitlement_reservations(id,grant_id,quantity,state) VALUES($1,$2,10,'reserved')",
      [reservation, f.grantId],
    );
    await pool.query(
      "UPDATE synthetic_entitlement_grants SET available=90,reserved=10 WHERE id=$1",
      [f.grantId],
    );
  } else
    reservation = await ledger.reserve(f.owner.id, f.grantId, 10, randomUUID());
  if (scenario === "duplicate-reserve")
    await event(f.owner.id, f.grantId, "reserve", 10, reservation);
  if (
    scenario === "consumed-without-event" ||
    scenario === "released-without-event"
  )
    await pool.query(
      "UPDATE synthetic_entitlement_reservations SET state=$2 WHERE id=$1",
      [reservation, scenario.startsWith("consumed") ? "consumed" : "released"],
    );
  if (scenario === "reserved-with-consume")
    await event(f.owner.id, f.grantId, "consume", 10, reservation);
  expect(
    category(await snapshot(f.operator.token)).reconciliation,
  ).toMatchObject({ status: "discrepancies", reservations: 1 });
});
it.each(["member", "grant", "result", "quantity"] as const)(
  "detects wrong %s on reservation events",
  async (link) => {
    const f = await fixture(),
      otherOwner = await member(),
      otherGrant = await ledger.grant(
        otherOwner.id,
        "support_minutes",
        100,
        randomUUID(),
        window,
      ),
      reservation = await ledger.reserve(
        f.owner.id,
        f.grantId,
        10,
        randomUUID(),
      );
    await event(
      link === "member" ? otherOwner.id : f.owner.id,
      link === "grant" ? otherGrant : f.grantId,
      "reserve",
      link === "quantity" ? 9 : 10,
      reservation,
      link === "result" ? f.grantId : reservation,
    );
    const result = await snapshot(f.operator.token),
      affected = link === "grant" ? "support_minutes" : "review_minutes";
    expect(category(result, affected).reconciliation.events).toBe(1);
    expect(category(result).reconciliation.reservations).toBe(1);
  },
);
it.each([
  "marker-without-event",
  "event-without-marker",
  "expire-exceeds-bucket",
])("detects structural expiry disagreement: %s", async (scenario) => {
  const f = await fixture();
  if (scenario === "marker-without-event")
    await pool.query(
      "UPDATE synthetic_entitlement_grants SET expired_at=clock_timestamp() WHERE id=$1",
      [f.grantId],
    );
  else {
    await event(f.owner.id, f.grantId, "expire", 20);
    if (scenario === "expire-exceeds-bucket")
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET expired_at=clock_timestamp(),expired=10,available=90 WHERE id=$1",
        [f.grantId],
      );
  }
  expect(
    category(await snapshot(f.operator.token)).reconciliation,
  ).toMatchObject({ status: "discrepancies", grants: 1 });
});
it.each([
  "matching",
  "member",
  "grant",
  "reservation",
  "category",
  "quantity",
  "event",
  "result",
  "unsupported-category",
] as const)(
  "validates retained attachment links independently: %s",
  async (mismatch) => {
    const f = await fixture(
        mismatch === "unsupported-category"
          ? "coach_minutes"
          : "review_minutes",
      ),
      other = await member(),
      otherGrant = await ledger.grant(
        other.id,
        "support_minutes",
        100,
        randomUUID(),
        window,
      ),
      reservation = await ledger.reserve(
        f.owner.id,
        f.grantId,
        30,
        randomUUID(),
      );
    const consume = randomUUID();
    await pool.query(
      "UPDATE synthetic_entitlement_grants SET reserved=reserved-30,consumed=consumed+30 WHERE id=$1",
      [f.grantId],
    );
    await pool.query(
      "UPDATE synthetic_entitlement_reservations SET state='consumed' WHERE id=$1",
      [reservation],
    );
    await pool.query(
      "INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id) VALUES($1,$2,$3,$4,'consume',30,$5,$6,$7)",
      [
        consume,
        f.owner.id,
        f.grantId,
        reservation,
        randomUUID(),
        "a".repeat(64),
        mismatch === "result" ? reservation : consume,
      ],
    );
    // The matching control satisfies every link. Each variant alters only its
    // named relationship where independent foreign keys permit that mismatch.
    const eventId =
      mismatch === "event"
        ? (
            await pool.query(
              "SELECT id FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation='grant'",
              [f.grantId],
            )
          ).rows[0].id
        : consume;
    const quantity = mismatch === "quantity" ? 20 : 30;
    await pool.query(
      "INSERT INTO synthetic_entitlement_settlements(id,member_id,grant_id,reservation_id,completion_ref,category,quantity,delivered_minutes,preparation_minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$7,0)",
      [
        eventId,
        mismatch === "member" ? other.id : f.owner.id,
        mismatch === "grant" ? otherGrant : f.grantId,
        mismatch === "reservation"
          ? await ledger.reserve(f.owner.id, f.grantId, 30, randomUUID())
          : reservation,
        `synthetic:${randomUUID()}`,
        mismatch === "category" ? "support_minutes" : "review_minutes",
        quantity,
      ],
    );
    const result = await snapshot(f.operator.token),
      name = mismatch === "grant" ? "support_minutes" : f.category;
    expect(category(result, name).reconciliation).toMatchObject({
      status: mismatch === "matching" ? "consistent" : "discrepancies",
      completions: mismatch === "matching" ? 0 : 1,
    });
    expect(category(result, name).observed.completions).toBe(1);
  },
);
describe.each(["fresh", "after member erasure"] as const)(
  "large retained ledger snapshot %s",
  (history) => {
    let f: Awaited<ReturnType<typeof fixture>>;
    // Prepare the retained dataset under the existing hook deadline. The actual
    // authorized snapshot and every assertion retain the default 5-second test
    // deadline; production statements independently remain bounded to 5 seconds.
    beforeEach(async () => {
      async function seed(ownerId: string) {
        await pool.query(
          `WITH seeded AS (
    INSERT INTO synthetic_entitlement_grants(id,member_id,category,quantity,available,starts_at,expires_at)
    SELECT gen_random_uuid(),$1,'study_requests',100000,100000,$2::timestamptz,$3::timestamptz FROM generate_series(1,22000)
    RETURNING id,member_id,quantity
  ) INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,operation,quantity,idempotency_key,request_fingerprint,result_id)
    SELECT gen_random_uuid(),member_id,id,'grant',quantity,id::text,repeat('a',64),id FROM seeded`,
          [ownerId, window.startsAt, window.expiresAt],
        );
      }
      if (history === "after member erasure") {
        const retired = await member();
        await seed(retired.id);
        await db.remove(retired.id);
        await pool.query(
          "ANALYZE synthetic_entitlement_grants; ANALYZE synthetic_entitlement_events",
        );
      }
      f = await fixture();
      await seed(f.owner.id);
    });
    it("keeps aggregate arithmetic exact beyond a 32-bit integer without returning source records", async () => {
      const result = await snapshot(f.operator.token),
        row = category(result, "study_requests");
      expect(row.observed).toMatchObject({
        grants: 22000,
        events: 22000,
        granted: 2200000000,
        available: 2200000000,
      });
      expect(row.reconciliation.status).toBe("consistent");
      expect(result.categories).toHaveLength(5);
      expect(JSON.stringify(result).length).toBeLessThan(5000);
    });
  },
);
it.each(["settlement", "adjustment", "expiry", "deletion"] as const)(
  "keeps one established statement snapshot during concurrent %s",
  async (change) => {
    const f = await fixture(),
      reservation = await ledger.reserve(
        f.owner.id,
        f.grantId,
        30,
        randomUUID(),
      ),
      before = category(await snapshot(f.operator.token));
    const blocker = await pool.connect(),
      gate = 42901,
      waiting = controlled(undefined, undefined, gate);
    let pending: ReturnType<typeof report.snapshot> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      await blocker.query("SELECT pg_advisory_xact_lock($1)", [gate]);
      pending = waiting.use.snapshot(f.operator.token);
      await waiting.connected.wait;
      await blocked(waiting.state.pid, pid);
      const mutationStarted = (await pool.query("SELECT clock_timestamp() at"))
        .rows[0].at as Date;
      if (change === "settlement")
        await ledger.settleCompletion(f.owner.id, reservation, randomUUID(), {
          reference: "synthetic:concurrent-completion",
          category: "review_minutes",
          deliveredMinutes: 20,
          preparationMinutes: 10,
        });
      if (change === "adjustment")
        await ledger.adjust(f.owner.id, f.grantId, 10, randomUUID());
      if (change === "expiry")
        await syntheticLedger(pool, () => new Date("2101-01-01")).expire(
          f.owner.id,
          f.grantId,
          randomUUID(),
        );
      if (change === "deletion") await db.remove(f.owner.id);
      await blocker.query("COMMIT");
      const old = await pending;
      if (old.kind !== "ready") throw Error("Expected coherent old snapshot");
      expect(old.value.asOf.valueOf()).toBeLessThanOrEqual(
        mutationStarted.valueOf(),
      );
      expect(category(old.value)).toEqual(before);
      const after = category(await snapshot(f.operator.token));
      expect(after.reconciliation.status).toBe("consistent");
      if (change === "settlement")
        expect(after.observed).toMatchObject({
          reserved: 0,
          consumed: 30,
          completions: 1,
        });
      if (change === "adjustment")
        expect(after.observed).toMatchObject({
          available: 60,
          adjusted: 10,
          reserved: 30,
        });
      if (change === "expiry")
        expect(after.observed).toMatchObject({
          available: 0,
          expired: 70,
          reserved: 30,
        });
      if (change === "deletion")
        expect(Object.values(after.observed)).toEqual(Array(10).fill(0));
      expect(
        waiting.state.calls.filter((sql) => sql.startsWith("WITH")),
      ).toHaveLength(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
  },
);
it.each(["revocation", "role", "expiry"] as const)(
  "denies changed %s after an observed authorization-row wait",
  async (change) => {
    const f = await fixture(),
      blocker = await pool.connect(),
      waiting = controlled();
    let pending: ReturnType<typeof report.snapshot> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
        .pid;
      if (change === "revocation")
        await blocker.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [f.operator.id],
        );
      if (change === "expiry")
        await blocker.query(
          "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [f.operator.id],
        );
      if (change === "role")
        await blocker.query(
          "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
          [f.operator.id],
        );
      pending = waiting.use.snapshot(f.operator.token);
      await waiting.connected.wait;
      await blocked(waiting.state.pid, pid);
      await blocker.query("COMMIT");
      expect(await pending).toEqual({ kind: "denied" });
      expect(waiting.state.calls.some((sql) => sql.startsWith("WITH"))).toBe(
        false,
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
  },
);
it("keeps authority stable until the report commits, then denies the changed role", async () => {
  const f = await fixture(),
    reading = controlled("WITH"),
    writer = await pool.connect(),
    pending = reading.use.snapshot(f.operator.token);
  let update: Promise<unknown> | undefined;
  try {
    await reading.reached.wait;
    await writer.query("BEGIN");
    const pid = (await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    update = writer.query(
      "UPDATE staff_profiles SET role='reviewer' WHERE principal_id=$1",
      [f.operator.id],
    );
    await blocked(pid, reading.state.pid);
    reading.resume.release();
    expect((await pending).kind).toBe("ready");
    await update;
    await writer.query("COMMIT");
    expect(await report.snapshot(f.operator.token)).toEqual({ kind: "denied" });
  } finally {
    reading.resume.release();
    await pending;
    await update;
    await writer.query("ROLLBACK");
    writer.release();
  }
});
it.each(["profile-wait", "after-report"] as const)(
  "checks database-clock expiry after %s",
  async (boundary) => {
    const f = await fixture(),
      deadline = new Date(Date.now() + 500);
    await pool.query("UPDATE principals SET expires_at=$2 WHERE id=$1", [
      f.operator.id,
      deadline,
    ]);
    if (boundary === "after-report") {
      const reading = controlled("WITH"),
        pending = reading.use.snapshot(f.operator.token);
      try {
        await reading.reached.wait;
        await pool.query(
          "SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)",
          [deadline],
        );
      } finally {
        reading.resume.release();
      }
      expect(await pending).toEqual({ kind: "denied" });
      expect(reading.state.calls).toContain("ROLLBACK");
    } else {
      const blocker = await pool.connect(),
        waiting = controlled();
      let pending: ReturnType<typeof report.snapshot> | undefined;
      try {
        await blocker.query("BEGIN");
        const pid = (await blocker.query("SELECT pg_backend_pid() pid")).rows[0]
          .pid;
        await blocker.query(
          "SELECT role FROM staff_profiles WHERE principal_id=$1 FOR UPDATE",
          [f.operator.id],
        );
        pending = waiting.use.snapshot(f.operator.token);
        await waiting.connected.wait;
        await blocked(waiting.state.pid, pid);
        await pool.query(
          "SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)",
          [deadline],
        );
        await blocker.query("COMMIT");
        expect(await pending).toEqual({ kind: "denied" });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await pending;
      }
    }
  },
);
it.each(["query", "commit", "rollback"] as const)(
  "returns no report or retry after real-connection %s uncertainty",
  async (failure) => {
    const f = await fixture(),
      failed =
        failure === "commit"
          ? controlled("COMMIT", "after")
          : controlled("WITH", "database", undefined, failure === "rollback");
    expect(await failed.use.snapshot(f.operator.token)).toEqual({
      kind: "unavailable",
    });
    expect(
      failed.state.calls.filter((sql) => sql.startsWith("BEGIN")),
    ).toHaveLength(1);
    expect(
      failed.state.calls.filter((sql) => sql.startsWith("WITH")),
    ).toHaveLength(1);
    expect(failed.state.discarded).toBe(failure === "rollback");
    // Discarded clients release real authorization locks; no broken transaction
    // remains checked into the pool, and normal subsequent reads still succeed.
    await pool.query(
      "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
      [f.operator.id],
    );
    expect(category(await snapshot(f.operator.token)).observed.granted).toBe(
      100,
    );
  },
);
