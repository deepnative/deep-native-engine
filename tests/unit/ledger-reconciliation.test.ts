import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledLedgerReconciliationStore,
  ledgerReconciliationStore,
} from "../../src/ledger-reconciliation.ts";

const token = "a".repeat(64),
  date = new Date("2026-10-01T12:00:00.000Z");
const fields = [
  "grants",
  "reservations",
  "events",
  "completions",
  "granted",
  "available",
  "reserved",
  "consumed",
  "expired",
  "adjusted",
  "grantEvents",
  "reserveEvents",
  "consumeEvents",
  "releaseEvents",
  "expireEvents",
  "adjustEvents",
  "attachedQuantity",
  "deliveredMinutes",
  "preparationMinutes",
  "consumedWithoutAttachment",
  "invalidGrants",
  "invalidReservations",
  "invalidEvents",
  "invalidCompletions",
];
function rows(): Record<string, unknown>[] {
  return [
    "coach_minutes",
    "review_minutes",
    "support_minutes",
    "mock_sessions",
    "study_requests",
  ].map((category) => ({
    category,
    asOf: date,
    ...Object.fromEntries(fields.map((field) => [field, "0"])),
  }));
}
function fixture(
  options: {
    principal?: boolean;
    profile?: boolean;
    current?: boolean | null;
    data?: Record<string, unknown>[];
    fail?: string;
    connectFail?: boolean;
    rollbackFail?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (
      (options.fail && sql.startsWith(options.fail)) ||
      (options.rollbackFail && sql === "ROLLBACK")
    )
      throw Error("Private query diagnostic synthetic:secret-member-data");
    if (sql.startsWith("SELECT id,expires_at"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "operator-id", expiresAt: new Date("2100-01-01") }],
      };
    if (sql.startsWith("SELECT role"))
      return { rows: options.profile === false ? [] : [{ role: "operator" }] };
    if (sql.startsWith("SELECT clock_timestamp"))
      return {
        rows:
          options.current === null
            ? []
            : [{ valid: options.current !== false }],
      };
    if (sql.startsWith("WITH")) return { rows: options.data ?? rows() };
    return { rows: [] };
  });
  const release = vi.fn(),
    connect = options.connectFail
      ? vi.fn().mockRejectedValue(Error("Private connection diagnostic"))
      : vi.fn().mockResolvedValue({ query, release });
  return {
    use: ledgerReconciliationStore({ connect } as unknown as Pool),
    query,
    connect,
    release,
  };
}

it("keeps an unconfigured reconciliation report unavailable", async () => {
  expect(
    await disabledLedgerReconciliationStore().snapshot("a".repeat(64)),
  ).toEqual({ kind: "unavailable" });
});
it("denies malformed identities before opening a database connection", async () => {
  const f = fixture();
  for (const value of [null, undefined, 42, "", "a".repeat(63), "A".repeat(64)])
    expect(await f.use.snapshot(value as string)).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
});
it("returns exactly five empty categories without treating their balances as capacity", async () => {
  const f = fixture(),
    result = await f.use.snapshot(token);
  expect(result).toEqual({
    kind: "ready",
    value: {
      scope: "synthetic-local-preview",
      asOf: date,
      categories: [
        "coach_minutes",
        "review_minutes",
        "support_minutes",
        "mock_sessions",
        "study_requests",
      ].map((category) => ({
        category,
        unit:
          category === "mock_sessions"
            ? "sessions"
            : category === "study_requests"
              ? "requests"
              : "minutes",
        observed: {
          grants: 0,
          reservations: 0,
          events: 0,
          completions: 0,
          granted: 0,
          available: 0,
          reserved: 0,
          consumed: 0,
          expired: 0,
          adjusted: 0,
        },
        events: {
          grant: 0,
          reserve: 0,
          consume: 0,
          release: 0,
          expire: 0,
          adjust: 0,
        },
        completion: {
          attachedQuantity: 0,
          deliveredMinutes: 0,
          preparationMinutes: 0,
          consumedWithoutAttachment: 0,
        },
        reconciliation: {
          status: "consistent",
          grants: 0,
          reservations: 0,
          events: 0,
          completions: 0,
        },
      })),
    },
  });
  expect(
    f.query.mock.calls.filter(([sql]) => sql.startsWith("WITH")),
  ).toHaveLength(1);
  expect(f.query.mock.calls.map(([sql]) => sql).at(-1)).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledWith(undefined);
});
it("retains every exact numeric observation and affected-record count without combining units", async () => {
  const data = rows();
  for (const [index, field] of fields.entries())
    data[1]![field] = String(index + 1);
  const result = await fixture({ data }).use.snapshot(token);
  if (result.kind !== "ready") throw Error("Expected report");
  expect(result.value.categories[1]).toEqual({
    category: "review_minutes",
    unit: "minutes",
    observed: {
      grants: 1,
      reservations: 2,
      events: 3,
      completions: 4,
      granted: 5,
      available: 6,
      reserved: 7,
      consumed: 8,
      expired: 9,
      adjusted: 10,
    },
    events: {
      grant: 11,
      reserve: 12,
      consume: 13,
      release: 14,
      expire: 15,
      adjust: 16,
    },
    completion: {
      attachedQuantity: 17,
      deliveredMinutes: 18,
      preparationMinutes: 19,
      consumedWithoutAttachment: 20,
    },
    reconciliation: {
      status: "discrepancies",
      grants: 21,
      reservations: 22,
      events: 23,
      completions: 24,
    },
  });
  expect(Object.keys(result.value)).toEqual(["scope", "asOf", "categories"]);
});
it.each([
  { principal: false },
  { profile: false },
  { current: false },
  { current: null },
])(
  "denies absent or expired authorization without retaining a partial report: %j",
  async (options) => {
    const f = fixture(options);
    expect(await f.use.snapshot(token)).toEqual({ kind: "denied" });
    expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(f.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  },
);
it("bounds integers deliberately and refuses lossy, malformed or negative database values", async () => {
  for (const value of [
    null,
    1,
    "-1",
    "1.5",
    "01",
    "NaN",
    "Infinity",
    "1e4",
    "9007199254740992",
    "10000000000000000",
  ]) {
    const data = rows();
    data[0]!.granted = value;
    const f = fixture({ data });
    expect(await f.use.snapshot(token)).toEqual({ kind: "unavailable" });
    expect(f.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  }
  const data = rows();
  data[0]!.granted = String(Number.MAX_SAFE_INTEGER);
  const result = await fixture({ data }).use.snapshot(token);
  expect(result).toMatchObject({
    kind: "ready",
    value: {
      categories: [
        expect.objectContaining({
          observed: expect.objectContaining({
            granted: Number.MAX_SAFE_INTEGER,
          }),
        }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ],
    },
  });
});
it("rejects missing/duplicate categories, changing snapshot time and any unapproved output field", async () => {
  const missing = rows().slice(1),
    extra = [...rows(), rows()[0]!];
  const changes: Record<string, unknown>[] = [
    { category: "coach_minutes" },
    { asOf: "2026-10-01" },
    { asOf: new Date("2026-10-02") },
    { memberId: "private-member-id" },
    { completion_ref: "synthetic:private-reference" },
  ];
  for (const data of [
    missing,
    extra,
    ...changes.map((change) => {
      const data = rows();
      Object.assign(data[1]!, change);
      return data;
    }),
  ])
    expect(await fixture({ data }).use.snapshot(token)).toEqual({
      kind: "unavailable",
    });
  for (const invalidTime of ["2026-10-01", new Date(NaN)]) {
    const data = rows();
    data[0]!.asOf = invalidTime;
    expect(await fixture({ data }).use.snapshot(token)).toEqual({
      kind: "unavailable",
    });
  }
  const data = rows();
  delete data[0]!.events;
  expect(await fixture({ data }).use.snapshot(token)).toEqual({
    kind: "unavailable",
  });
});
it.each([
  "BEGIN",
  "SET LOCAL lock",
  "SET LOCAL statement",
  "SET LOCAL enable_nestloop",
  "SELECT id",
  "SELECT role",
  "WITH",
  "SELECT clock_timestamp",
  "COMMIT",
])("returns no data and never retries after failure at %s", async (fail) => {
  const f = fixture({ fail });
  expect(await f.use.snapshot(token)).toEqual({ kind: "unavailable" });
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(f.release).toHaveBeenCalledWith(undefined);
});
it("does not leak connection errors and discards a client whose rollback failed", async () => {
  const connection = fixture({ connectFail: true });
  expect(await connection.use.snapshot(token)).toEqual({ kind: "unavailable" });
  expect(connection.release).not.toHaveBeenCalled();
  for (const options of [{ fail: "WITH" }, { principal: false }]) {
    const f = fixture({ ...options, rollbackFail: true });
    expect(await f.use.snapshot(token)).toEqual({ kind: "unavailable" });
    expect(f.release).toHaveBeenCalledWith(expect.any(Error));
    expect(f.connect).toHaveBeenCalledTimes(1);
  }
});
