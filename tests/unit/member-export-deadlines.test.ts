import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { memberExportStore } from "../../src/member-export.ts";

afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());
function driver(
  options: {
    query?: (sql: string) => Promise<unknown> | undefined;
    clock?: Record<string, unknown> | null;
    release?: () => void;
  } = {},
) {
  const statements: string[] = [];
  const release = vi.fn((error?: Error) => {
    options.release?.();
    return error;
  });
  const connection = {
    query: async (sql: string) => {
      statements.push(sql);
      const override = options.query?.(sql);
      if (override) return override;
      if (
        sql.startsWith("SELECT id FROM principals") ||
        sql.includes("FROM principals p JOIN learners l")
      )
        return { rows: [{ id: "invented-member" }] };
      if (sql.startsWith("WITH instant"))
        return {
          rows:
            options.clock === null
              ? []
              : [
                  options.clock ?? {
                    id: "invented-member",
                    // A transaction snapshot precedes its authority observation.
                    observedAt: new Date(1),
                    snapshotStartedAt: new Date(0),
                    remainingMs: "60000",
                  },
                ],
        };
      return { rows: [] };
    },
    release,
  };
  return {
    connection,
    statements,
    release,
    pool: { connect: async () => connection } as unknown as Pool,
  };
}
it("bounds acquisition and destroys a late acquired connection without reading records", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const fake = driver();
  let acquired!: (value: typeof fake.connection) => void;
  const pool = {
    connect: () =>
      new Promise((resolve) => {
        acquired = resolve;
      }),
  } as unknown as Pool;
  const operation = memberExportStore(pool).exportOwned("invented-token");
  await vi.advanceTimersByTimeAsync(3000);
  expect(await operation).toEqual({ kind: "unavailable" });
  acquired(fake.connection);
  await Promise.resolve();
  expect(fake.statements).toEqual([]);
  expect(fake.release).toHaveBeenCalledWith(expect.any(Error));
});
it.each(["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT"])(
  "withholds the entire page and discards the connection when %s never replies",
  async (stalled) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = driver({
      query: (sql) => (sql === stalled ? new Promise(() => {}) : undefined),
    });
    const operation = memberExportStore(fake.pool).exportOwned(
      "invented-token",
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await operation).toEqual({ kind: "unavailable" });
    expect(fake.release).toHaveBeenCalledWith(expect.any(Error));
    expect(fake.statements).not.toContain("ROLLBACK");
  },
);
it("withholds the page when the final authority clock is unavailable or malformed", async () => {
  for (const clock of [
    null,
    { remainingMs: "not-a-duration" },
    { remainingMs: "0" },
  ]) {
    const fake = driver({ clock });
    expect(
      await memberExportStore(fake.pool).exportOwned("invented-token"),
    ).toEqual({ kind: "denied" });
    expect(fake.statements).not.toContain("COMMIT");
  }
  for (const clock of [
    {
      remainingMs: "60000",
      observedAt: new Date(NaN),
      snapshotStartedAt: new Date(),
    },
    {
      remainingMs: "60000",
      observedAt: new Date(),
      snapshotStartedAt: new Date(NaN),
    },
    {
      remainingMs: "60000",
      observedAt: new Date(0),
      snapshotStartedAt: new Date(1),
    },
    {
      remainingMs: "60000",
      observedAt: "not-a-date",
      snapshotStartedAt: new Date(),
    },
    {
      remainingMs: "60000",
      observedAt: new Date(),
      snapshotStartedAt: "not-a-date",
    },
  ]) {
    const fake = driver({ clock });
    expect(
      await memberExportStore(fake.pool).exportOwned("invented-token"),
    ).toEqual({ kind: "unavailable" });
    expect(fake.statements).not.toContain("COMMIT");
    expect(fake.release).toHaveBeenCalledWith(expect.any(Error));
  }
});
it("charges commit and connection handback against the database-derived authority lifetime", async () => {
  for (const delayed of ["commit", "release"]) {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const fake = driver({
      clock: {
        remainingMs: "100",
        observedAt: new Date(1),
        snapshotStartedAt: new Date(0),
      },
      query: (sql) => {
        if (sql === "COMMIT" && delayed === "commit") elapsed += 101;
        return undefined;
      },
      release: () => {
        if (delayed === "release") elapsed += 101;
      },
    });
    expect(
      await memberExportStore(fake.pool).exportOwned("invented-token"),
    ).toEqual({ kind: "denied" });
    expect(fake.statements).toContain("COMMIT");
    expect(fake.statements).not.toContain("ROLLBACK");
    vi.restoreAllMocks();
  }
});
it("rejects late acquisition and late query replies even if an event loop delay prevents the timer firing first", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const acquired = driver();
  const pool = {
    connect: async () => {
      elapsed = 3000;
      return acquired.connection;
    },
  } as unknown as Pool;
  expect(await memberExportStore(pool).exportOwned("invented-token")).toEqual({
    kind: "unavailable",
  });
  expect(acquired.statements).toEqual([]);
  expect(acquired.release).toHaveBeenCalledWith(expect.any(Error));
  elapsed = 0;
  const queried = driver({
    query: (sql) => {
      if (sql === "COMMIT") elapsed += 5000;
      return undefined;
    },
  });
  expect(
    await memberExportStore(queried.pool).exportOwned("invented-token"),
  ).toEqual({ kind: "unavailable" });
  expect(queried.release).toHaveBeenCalledWith(expect.any(Error));
  expect(queried.statements).not.toContain("ROLLBACK");
});
it("bounds the cumulative operation even when each individual query replies within five seconds", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const fake = driver({
    query: () => {
      elapsed += 1900;
      return undefined;
    },
  });
  expect(
    await memberExportStore(fake.pool).exportOwned("invented-token"),
  ).toEqual({ kind: "unavailable" });
  expect(fake.statements).not.toContain("COMMIT");
  expect(fake.statements).not.toContain("ROLLBACK");
  expect(fake.release).toHaveBeenCalledWith(expect.any(Error));
});
it("withholds committed records on failed or over-budget handback", async () => {
  for (const fault of ["throw", "late"] as const) {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const fake = driver({
      release: () => {
        if (fault === "throw") throw Error("invented private driver failure");
        elapsed = 10000;
      },
    });
    expect(
      await memberExportStore(fake.pool).exportOwned("invented-token"),
    ).toEqual({ kind: "unavailable" });
    expect(fake.statements).toContain("COMMIT");
    expect(fake.statements).not.toContain("ROLLBACK");
    vi.restoreAllMocks();
  }
});
it("rolls back known query failure and discards a connection whose rollback fails", async () => {
  const fake = driver({
    query: (sql) =>
      sql.includes("FROM synthetic_entitlement_grants") || sql === "ROLLBACK"
        ? Promise.reject(Error("invented private driver failure"))
        : undefined,
  });
  expect(
    await memberExportStore(fake.pool).exportOwned("invented-token"),
  ).toEqual({ kind: "unavailable" });
  expect(fake.statements).toContain("ROLLBACK");
  expect(fake.release).toHaveBeenCalledWith(expect.any(Error));
});

it("withholds records when synchronous page encoding exhausts the remaining operation budget", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const original = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation(
    (...args: Parameters<typeof JSON.stringify>) => {
      const value = original(...args);
      if (args[0] && typeof args[0] === "object" && args[0].kind === "ready")
        elapsed = 10000;
      return value;
    },
  );
  const fake = driver();
  expect(
    await memberExportStore(fake.pool).exportOwned("invented-token"),
  ).toEqual({ kind: "unavailable" });
  expect(fake.statements).not.toContain("COMMIT");
  expect(fake.statements).not.toContain("ROLLBACK");
  expect(fake.release).toHaveBeenCalledWith(expect.any(Error));
});
it("rechecks the serialized byte cap after database timestamps are installed", async () => {
  let instruction = "";
  const options = {
    query: (sql: string) =>
      sql.includes("FROM exercises")
        ? Promise.resolve({
            rows: [
              { _key: ["lesson", 1, "work"], instruction },
              {
                _key: ["next", 1, "work"],
                instruction: "x".repeat(256 * 1024),
              },
            ],
          })
        : undefined,
  };
  const baseline = await memberExportStore(driver(options).pool).exportOwned(
    "invented-token",
  );
  if (baseline.kind !== "ready") throw Error("Missing bounded baseline");
  instruction = "x".repeat(
    256 * 1024 - Buffer.byteLength(JSON.stringify(baseline.payload)),
  );
  const fake = driver({
    ...options,
    clock: {
      remainingMs: "60000",
      observedAt: new Date("+010000-01-01T00:00:00.000Z"),
      snapshotStartedAt: new Date("+010000-01-01T00:00:00.000Z"),
    },
  });
  expect(
    await memberExportStore(fake.pool).exportOwned("invented-token"),
  ).toEqual({ kind: "limit" });
  expect(fake.statements).not.toContain("COMMIT");
  expect(fake.statements).toContain("ROLLBACK");
});

it("denies an active principal whose owned workspace is absent or deleting", async () => {
  const fake = driver({
    query: (sql) =>
      sql.includes("FROM principals p JOIN learners l")
        ? Promise.resolve({ rows: [] })
        : undefined,
  });
  expect(
    await memberExportStore(fake.pool).exportOwned("invented-token"),
  ).toEqual({ kind: "denied" });
  expect(fake.statements).not.toContain("COMMIT");
  expect(
    fake.statements.some((sql) => sql.includes("FROM synthetic_entitlement")),
  ).toBe(false);
  expect(fake.statements).toContain("ROLLBACK");
});
