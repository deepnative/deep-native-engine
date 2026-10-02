import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import {
  disabledMemberTestUnitsStore,
  memberTestUnitsStore,
  testUnitCategories,
} from "../../src/member-test-units.ts";
import { hash } from "../../src/store.ts";

const token = "a".repeat(64),
  memberId = "11111111-1111-4111-8111-111111111111",
  observed = new Date("2026-10-02T12:00:00Z"),
  later = new Date("2100-01-01T00:00:00Z");
function rows(): Record<string, unknown>[] {
  return testUnitCategories.map(([category, unit]) => ({
    category,
    unit,
    asOf: observed,
    valid: true,
    grants: "0",
    granted: "0",
    usable: "0",
    future: "0",
    awaitingExpiry: "0",
    held: "0",
    consumed: "0",
    expired: "0",
    adjusted: "0",
    nextExpiry: null,
    nextStart: null,
  }));
}
function fixture(
  options: {
    rows?: Record<string, unknown>[];
    member?: boolean;
    workspace?: boolean;
    expiry?: unknown;
    final?: { authorized: unknown; unexpired: unknown } | null;
    fail?: string;
    connectFailure?: boolean;
    rollbackFailure?: boolean;
    releaseFailure?: boolean;
    connectionErrorAt?: string;
  } = {},
) {
  const events = new EventEmitter();
  const query = vi.fn(async (sql: string) => {
    if (sql === options.connectionErrorAt)
      events.emit("error", Error("Connection lost"));
    if (
      options.fail &&
      (options.fail === "COMMIT"
        ? sql === "COMMIT"
        : sql.includes(options.fail))
    )
      throw Error("private DB marker");
    if (sql === "ROLLBACK" && options.rollbackFailure)
      throw Error("private rollback marker");
    if (sql.includes("SELECT p.id"))
      return {
        rows:
          options.member === false
            ? []
            : [{ id: memberId, expiresAt: options.expiry ?? later }],
      };
    if (sql.includes("SELECT id FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "workspace" }] };
    if (sql.startsWith("WITH observed"))
      return { rows: options.rows ?? rows() };
    if (sql.startsWith("SELECT clock_timestamp()<$1"))
      return {
        rows:
          options.final === null
            ? []
            : [options.final ?? { authorized: true, unexpired: true }],
      };
    return { rows: [] };
  });
  const release = vi.fn((error?: Error) => {
    void error;
    if (options.releaseFailure) throw Error("private release marker");
  });
  const connect = vi.fn(async () => {
    if (options.connectFailure) throw Error("private connection marker");
    return {
      query,
      release,
      on: events.on.bind(events),
      removeListener: events.removeListener.bind(events),
    };
  });
  return {
    query,
    events,
    release,
    connect,
    use: memberTestUnitsStore({ connect } as unknown as Pool),
  };
}
it("keeps an unconfigured reader unavailable and rejects malformed cookies before any database access", async () => {
  expect(await disabledMemberTestUnitsStore().snapshot(token)).toEqual({
    kind: "unavailable",
  });
  const f = fixture();
  for (const value of ["", " ", "A".repeat(64), "a".repeat(63), null, 1])
    expect(await f.use.snapshot(value as string)).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
});
it("returns an empty configured five-category snapshot without inventing grants and binds only the cookie owner", async () => {
  const f = fixture(),
    result = await f.use.snapshot(token);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready");
  expect(result.value.asOf).toEqual(observed);
  expect(
    result.value.categories.map((x) => [x.category, x.unit, x.granted]),
  ).toEqual(testUnitCategories.map(([c, u]) => [c, u, 0]));
  expect(JSON.stringify(result)).not.toContain(memberId);
  const calls = f.query.mock.calls as unknown as [string, unknown[]][];
  expect(calls.find(([sql]) => sql.includes("SELECT p.id"))![1]).toEqual([
    hash(token),
  ]);
  expect(calls.find(([sql]) => sql.startsWith("WITH observed"))![1]).toEqual([
    memberId,
  ]);
  expect(calls.filter(([sql]) => sql.startsWith("WITH observed"))).toHaveLength(
    1,
  );
  expect(
    calls.some(([sql]) => /^\s*(UPDATE|DELETE|INSERT|ALTER)/.test(sql)),
  ).toBe(false);
  expect(calls.at(-1)![0]).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
});
it("keeps seven accounting buckets separate and fences the earliest usable deadline across categories", async () => {
  const data = rows();
  Object.assign(data[0]!, {
    grants: "2",
    granted: "100",
    usable: "40",
    future: "10",
    awaitingExpiry: "5",
    held: "20",
    consumed: "10",
    expired: "10",
    adjusted: "5",
    nextExpiry: later,
    nextStart: later,
  });
  const earlier = new Date("2027-01-01T00:00:00Z");
  Object.assign(data[1]!, {
    grants: "1",
    granted: "3",
    usable: "3",
    nextExpiry: earlier,
  });
  Object.assign(data[2]!, {
    grants: "1",
    granted: "1",
    usable: "1",
    nextExpiry: later,
  });
  const f = fixture({ rows: data }),
    result = await f.use.snapshot(token);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected ready");
  expect(result.value.categories[0]).toMatchObject({
    usable: 40,
    future: 10,
    awaitingExpiry: 5,
    held: 20,
    consumed: 10,
    expired: 10,
    adjusted: 5,
  });
  expect(result.value.categories[1]!.usable).toBe(3);
  const final = (f.query.mock.calls as unknown as [string, unknown[]][]).find(
    ([sql]) => sql.startsWith("SELECT clock_timestamp()<$1"),
  );
  expect(final![1]).toEqual([later, earlier]);
});
it.each([
  { member: false },
  { workspace: false },
  { final: { authorized: false, unexpired: true } },
  { final: null },
])(
  "denies absent ownership or expired final authorization without a private result: %j",
  async (options) => {
    const f = fixture(options);
    expect(await f.use.snapshot(token)).toEqual({ kind: "denied" });
    expect(f.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  },
);
it("does not emit a usable balance if its deadline passes during assembly", async () => {
  const f = fixture({ final: { authorized: true, unexpired: false } });
  expect(await f.use.snapshot(token)).toEqual({ kind: "unavailable" });
  expect(f.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
});
it.each([
  "BEGIN",
  "lock_timeout",
  "statement_timeout",
  "SELECT p.id",
  "SELECT id FROM workspaces",
  "WITH observed",
  "SELECT clock_timestamp()<$1",
  "COMMIT",
])(
  "fails safely at database stage %s without replaying a private read",
  async (fail) => {
    const f = fixture({ fail });
    expect(await f.use.snapshot(token)).toEqual({ kind: "unavailable" });
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    if (fail === "COMMIT")
      expect(f.release.mock.calls[0]![0]).toBeInstanceOf(Error);
  },
);
it.each([
  { connectFailure: true },
  { member: false, rollbackFailure: true },
  { releaseFailure: true },
  { fail: "COMMIT", rollbackFailure: true },
])(
  "handles connection, rollback and release failures without exposing private data: %j",
  async (options) => {
    const f = fixture(options);
    expect(await f.use.snapshot(token)).toEqual({ kind: "unavailable" });
    if ("connectFailure" in options && options.connectFailure)
      expect(f.query).not.toHaveBeenCalled();
  },
);
it("rejects an invalid principal timestamp", async () => {
  expect(await fixture({ expiry: new Date(NaN) }).use.snapshot(token)).toEqual({
    kind: "unavailable",
  });
});
it.each(["-1", "1.5", "01", "1e3", "9007199254740992", null, 1, {}, "", " 1"])(
  "rejects corrupt/unsafe quantities %j rather than returning misleading zero",
  async (value) => {
    const data = rows();
    data[0]!.held = value;
    expect(await fixture({ rows: data }).use.snapshot(token)).toEqual({
      kind: "unavailable",
    });
  },
);
it.each([
  { category: "secret-other-category" },
  { unit: "cash" },
  { valid: false },
  { asOf: new Date("2026-10-02T12:00:01Z") },
  { asOf: "private timestamp" },
  { nextExpiry: new Date(NaN) },
  { nextStart: undefined },
  { granted: "1" },
  { grants: "1" },
  { usable: "1", granted: "1", grants: "1" },
  { future: "1", granted: "1", grants: "1" },
  { nextExpiry: later },
  { nextStart: later },
  { grants: "1", granted: "1", usable: "1", nextExpiry: observed },
  { grants: "1", granted: "1", future: "1", nextStart: observed },
  {
    grants: "1",
    granted: "9007199254740991",
    held: "9007199254740991",
    expired: "1",
  },
])(
  "rejects inconsistent category, timing or accounting evidence: %j",
  async (change) => {
    const data = rows();
    Object.assign(data[1]!, change);
    expect(await fixture({ rows: data }).use.snapshot(token)).toEqual({
      kind: "unavailable",
    });
  },
);
it.each([
  { data: [] },
  { data: rows().slice(0, 4) },
  { data: [...rows(), rows()[0]!] },
])("rejects incomplete/extra category rows", async ({ data }) => {
  expect(await fixture({ rows: data }).use.snapshot(token)).toEqual({
    kind: "unavailable",
  });
});
it("rejects an invalid first snapshot time rather than constructing a response", async () => {
  const data = rows();
  data[0]!.asOf = new Date(NaN);
  expect(await fixture({ rows: data }).use.snapshot(token)).toEqual({
    kind: "unavailable",
  });
});

it.each(["SET LOCAL statement_timeout='5s'", "COMMIT"])(
  "withholds a snapshot and destroys a connection that emits an error at %s",
  async (connectionErrorAt) => {
    const f = fixture({ connectionErrorAt });
    expect(await f.use.snapshot(token)).toEqual({ kind: "unavailable" });
    expect(f.release).toHaveBeenCalledWith(expect.any(Error));
    expect(f.events.listenerCount("error")).toBe(0);
  },
);
it("returns a healthy connection without retaining the reader's listener", async () => {
  const f = fixture();
  expect((await f.use.snapshot(token)).kind).toBe("ready");
  expect(f.events.listenerCount("error")).toBe(0);
});
