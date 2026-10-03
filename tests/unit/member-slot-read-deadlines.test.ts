import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { memberSlotHolds } from "../../src/slot-holds.ts";

afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());
const requestId = "44444444-4444-4444-8444-444444444444";
const receipt = { id: requestId, state: "released", quantity: 60 };
const clock = { observedAt: new Date(0), remainingMs: "60000", valid: true };
const kinds = ["get", "snapshot"] as const;
type Kind = (typeof kinds)[number];
function driver(
  options: {
    initialClock?: Record<string, unknown> | null;
    finalClock?: Record<string, unknown> | null;
    held?: boolean;
    query?: (sql: string) => Promise<unknown> | undefined;
    release?: () => void;
  } = {},
) {
  const statements: string[] = [];
  let observations = 0,
    receiptReads = 0;
  const connection = {
    query: async (sql: string) => {
      statements.push(sql);
      const overridden = options.query?.(sql);
      if (overridden) return overridden;
      if (sql.startsWith("WITH instant")) {
        const observation =
          observations++ === 0 ? options.initialClock : options.finalClock;
        return { rows: observation === null ? [] : [observation ?? clock] };
      }
      if (sql.includes("AS valid")) return { rows: [clock] };
      if (sql.includes("FOR SHARE OF p"))
        return {
          rows: [{ id: "invented-member", expiresAt: "2027-10-02T00:00:00Z" }],
        };
      if (sql.includes("SELECT id FROM workspaces"))
        return { rows: [{ id: "invented-workspace" }] };
      if (sql.includes("SELECT r.request_id")) {
        const initial = receiptReads++ === 0;
        return {
          rows: [
            {
              ...receipt,
              state: initial && options.held ? "held" : "released",
            },
          ],
        };
      }
      if (sql.includes("SELECT g.id,g.category"))
        return { rows: [{ id: "invented-grant", category: "coach_minutes" }] };
      return { rows: [] };
    },
    release: vi.fn((_error?: Error) => options.release?.()),
  };
  return {
    connection,
    statements,
    pool: {
      query: connection.query,
      connect: async () => connection,
    } as unknown as Pool,
  };
}
function read(pool: Pool, kind: Kind) {
  const api = memberSlotHolds(pool);
  return kind === "get"
    ? api.get("invented-token", requestId)
    : api.snapshot("invented-token");
}
async function denies(pool: Pool, kind: Kind) {
  if (kind === "get") expect(await read(pool, kind)).toBeNull();
  else
    await expect(read(pool, kind)).rejects.toMatchObject({
      code: "unavailable",
    });
}
function elapsedClock() {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  return {
    add: (ms: number) => {
      elapsed += ms;
    },
  };
}

it.each(kinds)(
  "withholds %s across a late successful commit or resource handback",
  async (kind) => {
    for (const stage of ["commit", "release"] as const) {
      const elapsed = elapsedClock();
      const fake = driver({
        finalClock: { ...clock, remainingMs: "100" },
        query: (sql) => {
          if (stage === "commit" && sql === "COMMIT") elapsed.add(101);
          return undefined;
        },
        release: () => {
          if (stage === "release") elapsed.add(101);
        },
      });
      await denies(fake.pool, kind);
      expect(fake.statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(fake.statements).not.toContain("ROLLBACK");
      expect(fake.connection.release).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  },
);
it.each(kinds)(
  "charges early preparation and settlement replies against %s authority",
  async (kind) => {
    for (const delayed of ["observation", "initial read", "settlement"]) {
      const elapsed = elapsedClock();
      let receiptReads = 0;
      const fake = driver({
        held: true,
        initialClock: { ...clock, remainingMs: "100" },
        query: (sql) => {
          if (
            (delayed === "observation" && sql.startsWith("WITH instant")) ||
            (delayed === "initial read" &&
              sql.includes("SELECT r.request_id") &&
              receiptReads++ === 0) ||
            (delayed === "settlement" &&
              sql.includes("SELECT settle_member_sample_holds"))
          )
            elapsed.add(101);
          return undefined;
        },
      });
      await denies(fake.pool, kind);
      expect(fake.statements).not.toContain("BEGIN");
      expect(fake.statements).not.toContain("COMMIT");
      expect(
        fake.statements.filter((sql) =>
          sql.includes("SELECT settle_member_sample_holds"),
        ).length,
      ).toBe(delayed === "settlement" ? 1 : 0);
      vi.restoreAllMocks();
    }
  },
);
it("does not extend authority with a later observation or use host wall-clock skew", async () => {
  const elapsed = elapsedClock();
  let receiptReads = 0;
  const fake = driver({
    initialClock: { ...clock, remainingMs: "100" },
    query: (sql) => {
      if (sql.includes("SELECT r.request_id") && receiptReads++ === 1)
        elapsed.add(50);
      if (sql === "COMMIT") elapsed.add(51);
      return undefined;
    },
  });
  expect(await read(fake.pool, "get")).toBeNull();
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(8_000_000_000_000);
  expect(await read(driver().pool, "get")).toEqual(receipt);
});
it.each(["initial", "final"])(
  "withholds all private results on malformed %s DB lifetime observations",
  async (stage) => {
    for (const bad of [
      { ...clock, remainingMs: "not-a-duration" },
      { ...clock, remainingMs: "" },
      { ...clock, remainingMs: null },
      { ...clock, remainingMs: 1000 },
      { ...clock, remainingMs: "Infinity" },
      { ...clock, observedAt: new Date(NaN) },
      { ...clock, observedAt: "not-a-date" },
      { ...clock, valid: false },
    ]) {
      const fake = driver(
        stage === "initial" ? { initialClock: bad } : { finalClock: bad },
      );
      await expect(read(fake.pool, "snapshot")).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(fake.statements).not.toContain("COMMIT");
      expect(fake.connection.release).toHaveBeenCalledWith(expect.any(Error));
    }
  },
);
it.each(["initial", "final"])(
  "denies missing %s authority and nonpositive remaining lifetime",
  async (stage) => {
    for (const observation of [
      null,
      { ...clock, remainingMs: "0" },
      { ...clock, remainingMs: "-1" },
    ]) {
      const fake = driver(
        stage === "initial"
          ? { initialClock: observation }
          : { finalClock: observation },
      );
      // Both denial and bounded-cleanup unavailability withhold the payload.
      await expect(read(fake.pool, "snapshot")).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(fake.statements).not.toContain("COMMIT");
    }
  },
);
it("bounds acquisition and discards a late client, including a failed late resource return", async () => {
  for (const brokenRelease of [false, true]) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = driver({
      release: () => {
        if (brokenRelease) throw Error("invented release fault");
      },
    });
    let acquire!: (value: typeof fake.connection) => void;
    const pool = {
      connect: () =>
        new Promise((resolve) => {
          acquire = resolve;
        }),
    } as unknown as Pool;
    const operation = read(pool, "snapshot");
    const assertion = expect(operation).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    acquire(fake.connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.statements).toEqual([]);
    expect(fake.connection.release).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  }
});
it("discards a client whose acquisition resolves after the elapsed acquisition limit", async () => {
  const elapsed = elapsedClock(),
    fake = driver();
  const pool = {
    connect: async () => {
      elapsed.add(3001);
      return fake.connection;
    },
  } as unknown as Pool;
  await expect(read(pool, "snapshot")).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(fake.statements).toEqual([]);
  expect(fake.connection.release).toHaveBeenCalledTimes(1);
});
it.each([
  "SET statement_timeout",
  "WITH instant",
  "SELECT r.request_id",
  "SELECT settle_member_sample_holds",
  "BEGIN",
  "FOR SHARE OF p",
  "SELECT id FROM workspaces",
  "SELECT g.id,g.category",
  "COMMIT",
  "ROLLBACK",
])(
  "bounds a withheld %s reply without queuing rollback or retry behind it",
  async (stalled) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = driver({
      held: true,
      finalClock: stalled === "ROLLBACK" ? null : undefined,
      query: (sql) =>
        sql.includes(stalled) ? new Promise(() => {}) : undefined,
    });
    const operation = read(fake.pool, "snapshot");
    const assertion = expect(operation).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(fake.connection.release).toHaveBeenCalledTimes(1);
    expect(fake.statements.filter((sql) => sql.includes(stalled))).toHaveLength(
      1,
    );
    if (stalled !== "ROLLBACK")
      expect(fake.statements).not.toContain("ROLLBACK");
  },
);
it("bounds cumulative successful stages and synchronous resource handback", async () => {
  for (const handback of [false, true]) {
    const elapsed = elapsedClock();
    const fake = driver({
      query: (sql) => {
        if (!handback)
          elapsed.add(sql.includes("SELECT r.request_id") ? 1000 : 3000);
        return undefined;
      },
      release: () => {
        if (handback) elapsed.add(10001);
      },
    });
    await expect(read(fake.pool, "snapshot")).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(fake.connection.release).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  }
});
it("withholds on resource-return failure after known commit without issuing rollback", async () => {
  const fake = driver({
    release: () => {
      throw Error("invented release fault");
    },
  });
  await expect(read(fake.pool, "snapshot")).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(fake.statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
  expect(fake.statements).not.toContain("ROLLBACK");
});
