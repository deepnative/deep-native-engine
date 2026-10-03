import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  memberExportStore,
  type MemberExportPayload,
} from "../../src/member-export.ts";
import { syntheticLedger, type LedgerCategory } from "../../src/ledger.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  exports = memberExportStore(pool);
const names = [
  "testUnitGrants",
  "testUnitReservations",
  "testUnitEvents",
  "testUnitSettlements",
] as const;
const fields = {
  testUnitGrants: [
    "id",
    "category",
    "quantity",
    "available",
    "reserved",
    "consumed",
    "expired",
    "adjusted",
    "createdAt",
    "startsAt",
    "expiresAt",
    "expiredAt",
  ],
  testUnitReservations: [
    "id",
    "grantId",
    "category",
    "quantity",
    "state",
    "createdAt",
  ],
  testUnitEvents: [
    "id",
    "grantId",
    "reservationId",
    "category",
    "operation",
    "quantity",
    "createdAt",
  ],
  testUnitSettlements: [
    "id",
    "grantId",
    "reservationId",
    "category",
    "quantity",
    "deliveredMinutes",
    "preparationMinutes",
    "createdAt",
  ],
};
beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => pool.end());

async function member() {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "professional", goal: "work" });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token, id: session.learner.id };
}
async function history(memberId: string) {
  let now = new Date();
  const startsAt = new Date(+now - 60_000).toISOString(),
    ends = new Date(+now + 60_000);
  const ledger = syntheticLedger(pool, () => now);
  const ids: {
    grantId: string;
    category: LedgerCategory;
    consumed: string;
    released: string;
    held: string;
  }[] = [];
  const categories: LedgerCategory[] = [
    "coach_minutes",
    "review_minutes",
    "support_minutes",
    "mock_sessions",
    "study_requests",
  ];
  for (const category of categories) {
    const grantId = await ledger.grant(
      memberId,
      category,
      8,
      "invented-private-replay-" + randomUUID(),
      { startsAt, expiresAt: ends.toISOString() },
    );
    const consumed = await ledger.reserve(memberId, grantId, 1, randomUUID());
    if (category === "study_requests") {
      await ledger.settleCompletion(memberId, consumed, randomUUID(), {
        reference: "synthetic:invented-private-completion-" + randomUUID(),
        category,
        quantity: 1,
      });
    } else if (
      category === "review_minutes" ||
      category === "support_minutes"
    ) {
      await ledger.settleCompletion(memberId, consumed, randomUUID(), {
        reference: "synthetic:invented-private-completion-" + randomUUID(),
        category,
        deliveredMinutes: 1,
        preparationMinutes: 0,
      });
    } else await ledger.consume(memberId, consumed, randomUUID());
    const released = await ledger.reserve(memberId, grantId, 1, randomUUID());
    await ledger.release(memberId, released, randomUUID());
    const held = await ledger.reserve(memberId, grantId, 1, randomUUID());
    await ledger.adjust(memberId, grantId, 1, randomUUID());
    ids.push({ grantId, category, consumed, released, held });
  }
  now = new Date(+ends + 1000);
  for (const { grantId } of ids)
    await ledger.expire(memberId, grantId, randomUUID());
  return ids;
}
async function pages(token: string) {
  const all: MemberExportPayload[] = [];
  let cursor: string | undefined;
  do {
    const value = await exports.exportOwned(token, cursor);
    expect(value.kind).toBe("ready");
    if (value.kind !== "ready") throw Error("Private export unavailable");
    all.push(value.payload);
    cursor = value.payload.page.nextCursor ?? undefined;
    expect(all.length).toBeLessThan(30);
  } while (cursor);
  return Object.fromEntries(
    names.map((name) => [
      name,
      all.flatMap((page) => page.records[name] ?? []),
    ]),
  );
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    "synthetic_entitlement_grants",
    "synthetic_entitlement_reservations",
    "synthetic_entitlement_events",
    "synthetic_entitlement_settlements",
    "synthetic_slot_holds",
    "local_ai_test_unit_jobs",
    "support_time_allocations",
    "support_time_entries",
  ]) {
    result[table] = (
      await pool.query(`SELECT * FROM ${table} ORDER BY 1`)
    ).rows;
  }
  return result;
}

it("downloads all retained owned test-unit categories and operations with exact privacy whitelist, without changing accounting", async () => {
  const own = await member(),
    other = await member();
  const fixture = await history(own.id);
  await history(other.id);
  const before = await snapshot(),
    records = await pages(own.token);
  expect(records.testUnitGrants).toHaveLength(5);
  expect(records.testUnitReservations).toHaveLength(15);
  expect(records.testUnitEvents).toHaveLength(40);
  expect(records.testUnitSettlements).toHaveLength(3);
  expect(new Set(records.testUnitEvents!.map((row) => row.operation))).toEqual(
    new Set(["grant", "reserve", "consume", "release", "expire", "adjust"]),
  );
  for (const name of names)
    for (const row of records[name]!) {
      expect(Object.keys(row).sort()).toEqual([...fields[name]].sort());
      expect(row.createdAt).toBeInstanceOf(Date);
    }
  for (const f of fixture) {
    expect(records.testUnitGrants).toContainEqual(
      expect.objectContaining({
        id: f.grantId,
        category: f.category,
        quantity: 8,
        available: 0,
        reserved: 1,
        consumed: 1,
        expired: 5,
        adjusted: 1,
      }),
    );
    for (const [id, state] of [
      [f.consumed, "consumed"],
      [f.released, "released"],
      [f.held, "reserved"],
    ])
      expect(records.testUnitReservations).toContainEqual(
        expect.objectContaining({
          id,
          grantId: f.grantId,
          category: f.category,
          state,
          quantity: 1,
        }),
      );
  }
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain(own.id);
  expect(serialized).not.toContain(other.id);
  expect(serialized).not.toContain("invented-private-replay");
  expect(serialized).not.toContain("invented-private-completion");
  expect(await pages(own.token)).toEqual(records);
  expect(await snapshot()).toEqual(before);
});

it("does not reveal another member's retained history or grant a staff role member export authority", async () => {
  const own = await member(),
    empty = await member();
  await history(own.id);
  const records = await pages(empty.token);
  for (const name of names) expect(records[name]).toEqual([]);
  const staff = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    staff,
    "platform_admin",
    new Date(Date.now() + 60_000),
  );
  expect(await exports.exportOwned(staff)).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [own.id],
  );
  expect(await exports.exportOwned(own.token)).toEqual({ kind: "denied" });
});

it("erases owned grant, reservation, event and settlement records and denies future export", async () => {
  const own = await member();
  await history(own.id);
  expect((await pages(own.token)).testUnitEvents).toHaveLength(40);
  await members.remove(own.id);
  expect(await exports.exportOwned(own.token)).toEqual({ kind: "denied" });
  for (const table of [
    "synthetic_entitlement_grants",
    "synthetic_entitlement_reservations",
    "synthetic_entitlement_events",
    "synthetic_entitlement_settlements",
  ])
    expect(
      Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count),
    ).toBe(0);
});

it("paginates more than 100 mixed retained rows without omissions or duplicates and rechecks every continuation", async () => {
  const own = await member(),
    other = await member();
  for (let i = 0; i < 6; i++) await history(own.id);
  await history(other.id);
  const before = await snapshot();
  const collected: Record<string, Record<string, unknown>[]> =
    Object.fromEntries(names.map((name) => [name, []]));
  let cursor: string | undefined,
    number = 0;
  do {
    const value = await exports.exportOwned(own.token, cursor);
    expect(value.kind).toBe("ready");
    if (value.kind !== "ready") throw Error("Private export unavailable");
    const payload = value.payload;
    expect(payload.version).toBe("local-member-records-v18");
    expect(payload.page.number).toBe(++number);
    expect(payload.page.consistency).toBe("live-pages");
    expect(payload.page.recordCount).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(payload.testUnitHistory).toMatchObject({
      scope: "private-local-test-units",
      availableMeaning: "stored-counter-not-usable-balance",
      snapshotStartedAt: expect.any(Date),
      observedAt: expect.any(Date),
    });
    expect(+payload.testUnitHistory.observedAt).toBeGreaterThanOrEqual(
      +payload.testUnitHistory.snapshotStartedAt,
    );
    for (const name of names) collected[name]!.push(...payload.records[name]!);
    cursor = payload.page.nextCursor ?? undefined;
    if (cursor) {
      expect(await exports.exportOwned(other.token, cursor)).toEqual({
        kind: "denied",
      });
      const [body, signature] = cursor.split(".");
      const altered = signature![0] === "A" ? "B" : "A";
      expect(
        await exports.exportOwned(
          own.token,
          `${body}.${altered}${signature!.slice(1)}`,
        ),
      ).toEqual({ kind: "denied" });
    }
    expect(number).toBeLessThan(10);
  } while (cursor);
  expect(number).toBeGreaterThan(3);
  for (const [name, table] of [
    ["testUnitGrants", "synthetic_entitlement_grants"],
    ["testUnitReservations", "synthetic_entitlement_reservations"],
    ["testUnitEvents", "synthetic_entitlement_events"],
    ["testUnitSettlements", "synthetic_entitlement_settlements"],
  ]) {
    const expected = table!.endsWith("reservations")
      ? await pool.query(
          `SELECT r.id FROM ${table} r JOIN synthetic_entitlement_grants g ON g.id=r.grant_id WHERE g.member_id=$1 ORDER BY r.id`,
          [own.id],
        )
      : await pool.query(
          `SELECT id FROM ${table} WHERE member_id=$1 ORDER BY id`,
          [own.id],
        );
    expect(collected[name!]!.map((row) => row.id)).toEqual(
      expected.rows.map((row) => row.id),
    );
    expect(new Set(collected[name!]!.map((row) => row.id)).size).toBe(
      expected.rowCount,
    );
  }
  expect(await snapshot()).toEqual(before);
});

it("filters corrupt cross-member grant and reservation references before history pagination", async () => {
  const own = await member(),
    other = await member();
  const owned = await history(own.id),
    foreign = await history(other.id);
  const before = await pages(own.token);
  const inserts = [
    {
      member: own.id,
      grant: foreign[0]!.grantId,
      reservation: null,
      operation: "grant",
    },
    {
      member: other.id,
      grant: owned[0]!.grantId,
      reservation: null,
      operation: "grant",
    },
    {
      member: own.id,
      grant: owned[0]!.grantId,
      reservation: foreign[0]!.held,
      operation: "reserve",
    },
  ];
  for (const row of inserts)
    await pool.query(
      `INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8)`,
      [
        randomUUID(),
        row.member,
        row.grant,
        row.reservation,
        row.operation,
        randomUUID(),
        "f".repeat(64),
        randomUUID(),
      ],
    );
  // Independent FKs alone also permit a settlement tied to a foreign member's
  // event. The reader must require the same owned event/grant/reservation tuple.
  const badSettlement = randomUUID(),
    study = owned.find((row) => row.category === "study_requests")!;
  await pool.query(
    "INSERT INTO synthetic_entitlement_events(id,member_id,grant_id,reservation_id,operation,quantity,idempotency_key,request_fingerprint,result_id) VALUES($1,$2,$3,$4,'consume',1,$5,$6,$7)",
    [
      badSettlement,
      other.id,
      study.grantId,
      study.held,
      randomUUID(),
      "e".repeat(64),
      randomUUID(),
    ],
  );
  await pool.query(
    "INSERT INTO synthetic_entitlement_settlements(id,member_id,grant_id,reservation_id,completion_ref,category,quantity) VALUES($1,$2,$3,$4,$5,'study_requests',1)",
    [
      badSettlement,
      own.id,
      study.grantId,
      study.held,
      "synthetic:foreign-event-" + randomUUID(),
    ],
  );
  expect(await pages(own.token)).toEqual(before);
});

it("keeps history readable while a ledger writer holds a grant update lock and measures bounded query candidates", async () => {
  const own = await member(),
    foreign = await member();
  const fixture = await history(own.id);
  for (let i = 0; i < 8; i++) await history(foreign.id);
  const before = await pages(own.token);
  const writer = await pool.connect();
  const queries: { sql: string; values: unknown[] | undefined }[] = [];
  const wrapper = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql: string, values?: unknown[]) => {
          if (
            sql.includes('AS "_key"') &&
            /FROM synthetic_entitlement_(grants g|reservations r|events e|settlements s)/.test(
              sql,
            )
          )
            queries.push({ sql, values });
          return client.query(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  } as unknown as import("pg").Pool;
  try {
    await writer.query("BEGIN");
    await writer.query(
      "SELECT id FROM synthetic_entitlement_grants WHERE id=$1 FOR UPDATE",
      [fixture[0]!.grantId],
    );
    const started = performance.now();
    const value = await memberExportStore(wrapper).exportOwned(own.token);
    expect(value.kind).toBe("ready");
    expect(performance.now() - started).toBeLessThan(3000);
    if (value.kind !== "ready") throw Error("Private export unavailable");
    for (const name of names)
      expect(value.payload.records[name]).toEqual(before[name]);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
  expect(queries).toHaveLength(4);
  for (const { sql, values } of queries) {
    expect(Number(values![1])).toBeLessThanOrEqual(101);
    expect(sql).not.toContain("FOR SHARE");
    const result = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      values,
    );
    const plan = result.rows[0]["QUERY PLAN"][0];
    expect(plan.Plan["Node Type"]).toBe("Limit");
    expect(plan.Plan["Actual Rows"]).toBeLessThanOrEqual(Number(values![1]));
    expect(plan["Execution Time"]).toBeLessThan(1000);
  }
});
