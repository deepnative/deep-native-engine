// The event transaction has the same finite-authority contract as circle grants.
// Reuse those behavioral scenarios against this independent event boundary.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  EventCancellationFailure,
  eventCancellationTransaction,
} from "../../src/event-cancellation-lifetime.ts";
beforeEach(() =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }),
);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const instant = new Date("2026-10-06T12:00:00.000Z");
function fixture() {
  const state = {
    row: { remaining: "2000", observed: instant } as unknown,
    fail: "",
    never: "",
    commitDelay: 0,
    releaseDelay: 0,
    releaseError: false,
    queryHandback: "",
    queryDelay: 0,
  };
  const statements: string[] = [];
  const release = vi.fn(() => {
    if (state.releaseDelay) vi.advanceTimersByTime(state.releaseDelay);
    if (state.releaseError) throw Error("private release error");
  });
  const client = {
    query: (async (sql: string) => {
      statements.push(sql);
      if (sql === state.fail) throw Error("private query error");
      if (sql === state.never) return new Promise(() => {});
      if (sql === "COMMIT" && state.commitDelay)
        await new Promise((resolve) => setTimeout(resolve, state.commitDelay));
      if (sql === state.queryHandback) vi.advanceTimersByTime(state.queryDelay);
      return {
        rows: sql.includes("WITH instant")
          ? state.row === undefined
            ? []
            : [state.row]
          : [],
      };
    }) as PoolClient["query"],
    release,
  };
  const connect = vi.fn(async () => client);
  return {
    state,
    statements,
    release,
    connect,
    client,
    pool: { connect } as unknown as Pool,
  };
}
const read = (pool: Pool, writing = false) =>
  eventCancellationTransaction(pool, writing, async (tx) => {
    await tx.observe([instant]);
    return (observed) => ({ observed, private: "invented" });
  });
async function advance<T>(promise: Promise<T>, elapsed = 0) {
  await vi.advanceTimersByTimeAsync(elapsed);
  return promise;
}
it("EVCANCEL-05 returns a successful result only after commit and release with the original earliest deadline", async () => {
  const f = fixture();
  const result = await eventCancellationTransaction(
    f.pool,
    true,
    async (tx) => {
      await tx.observe([instant, new Date(+instant + 1000)]);
      vi.advanceTimersByTime(100);
      f.state.row = { remaining: "5000", observed: new Date(+instant + 100) };
      await tx.observe([new Date(+instant + 5000)]);
      return (observed) => ({ observed });
    },
  );
  expect(result).toEqual({
    kind: "ready",
    value: { observed: new Date(+instant + 100) },
    observedAt: new Date(+instant + 100),
    deadline: 2000,
  });
  expect(f.statements.at(-1)).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
});
it.each([false, true])(
  "EVCANCEL-05 withholds a late commit reply and never repeats or compensates the write (writing=%s)",
  async (writing) => {
    const f = fixture();
    f.state.commitDelay = 2500;
    expect(await advance(read(f.pool, writing), 2001)).toEqual({
      kind: writing ? "unavailable" : "denied",
    });
    expect(f.statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(f.statements).not.toContain("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
  },
);
it.each([false, true])(
  "EVCANCEL-05 rejects authority that expires during native release (writing=%s)",
  async (writing) => {
    const f = fixture();
    f.state.releaseDelay = 2100;
    expect(await read(f.pool, writing)).toEqual({
      kind: writing ? "unavailable" : "denied",
    });
  },
);
it("EVCANCEL-05 keeps request expiry stricter than a longer credential and charges native handback", async () => {
  const f = fixture();
  f.state.row = { remaining: "20000", observed: instant };
  f.state.releaseDelay = 10001;
  expect(await read(f.pool)).toEqual({ kind: "unavailable" });
});
it("EVCANCEL-06 does not queue rollback behind an unresolved query", async () => {
  const f = fixture();
  f.state.never = "SELECT exact grant";
  const promise = eventCancellationTransaction(f.pool, false, async (tx) => {
    await tx.observe([instant]);
    await tx.query("SELECT exact grant");
    return () => "not exposed";
  });
  expect(await advance(promise, 2001)).toEqual({ kind: "denied" });
  expect(f.statements).not.toContain("ROLLBACK");
  expect(f.release).toHaveBeenCalledOnce();
});
it("EVCANCEL-06 classifies a query timing out before authority observation as unavailable", async () => {
  const f = fixture();
  f.state.never = "BEGIN";
  expect(await advance(read(f.pool), 5001)).toEqual({ kind: "unavailable" });
  expect(f.statements).toEqual(["BEGIN"]);
});
it("EVCANCEL-05 charges a query acknowledgement that arrives exactly at its authority deadline", async () => {
  const f = fixture();
  f.state.queryHandback = "SELECT exact grant";
  f.state.queryDelay = 2000;
  expect(
    await eventCancellationTransaction(f.pool, false, async (tx) => {
      await tx.observe([instant]);
      await tx.query("SELECT exact grant");
      return () => "not exposed";
    }),
  ).toEqual({ kind: "denied" });
  expect(f.statements).not.toContain("COMMIT");
  expect(f.statements).not.toContain("ROLLBACK");
});
it("EVCANCEL-05 refuses another query after the already-observed earliest lifetime", async () => {
  const f = fixture();
  expect(
    await eventCancellationTransaction(f.pool, false, async (tx) => {
      await tx.observe([instant]);
      vi.advanceTimersByTime(2000);
      await tx.query("must not run");
      return () => "not exposed";
    }),
  ).toEqual({ kind: "denied" });
  expect(f.statements).not.toContain("must not run");
});
it("EVCANCEL-05 request exhaustion before another query is unavailable", async () => {
  const f = fixture();
  f.state.row = { remaining: "20000", observed: instant };
  expect(
    await eventCancellationTransaction(f.pool, false, async (tx) => {
      await tx.observe([instant]);
      vi.advanceTimersByTime(10000);
      await tx.query("must not run");
      return () => "not exposed";
    }),
  ).toEqual({ kind: "unavailable" });
  expect(f.statements).not.toContain("must not run");
});
it("EVCANCEL-06 rolls back a known precommit failure and withholds database error details", async () => {
  const f = fixture();
  f.state.fail = "SELECT exact grant";
  expect(
    await eventCancellationTransaction(f.pool, false, async (tx) => {
      await tx.observe([instant]);
      await tx.query("SELECT exact grant");
      return () => "not exposed";
    }),
  ).toEqual({ kind: "unavailable" });
  expect(f.statements.at(-1)).toBe("ROLLBACK");
});
it.each(["denied", "invalid", "conflict", "unavailable"] as const)(
  "EVCANCEL-05 preserves an explicit %s result before commit",
  async (kind) => {
    const f = fixture();
    expect(
      await eventCancellationTransaction(f.pool, false, async () => {
        throw new EventCancellationFailure(kind);
      }),
    ).toEqual({ kind });
    expect(f.statements.at(-1)).toBe("ROLLBACK");
  },
);
it("EVCANCEL-06 reports failed rollback as unavailable without repeating it", async () => {
  const f = fixture();
  f.state.fail = "ROLLBACK";
  expect(
    await eventCancellationTransaction(f.pool, false, async () => {
      throw new EventCancellationFailure("conflict");
    }),
  ).toEqual({ kind: "unavailable" });
  expect(f.statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
});
it("EVCANCEL-06 treats a failed commit acknowledgement as uncertain and does not issue rollback", async () => {
  const f = fixture();
  f.state.fail = "COMMIT";
  expect(await read(f.pool, true)).toEqual({ kind: "unavailable" });
  expect(f.statements).not.toContain("ROLLBACK");
});
it("EVCANCEL-05 withholds successful data if release fails", async () => {
  const f = fixture();
  f.state.releaseError = true;
  expect(await read(f.pool)).toEqual({ kind: "unavailable" });
});
it("EVCANCEL-05 refuses a transaction without an authority observation", async () => {
  const f = fixture();
  expect(
    await eventCancellationTransaction(
      f.pool,
      false,
      async () => () => "not exposed",
    ),
  ).toEqual({ kind: "unavailable" });
  expect(f.statements).not.toContain("COMMIT");
});
it.each<{ expires: unknown[] }>([
  { expires: [] },
  { expires: [new Date(NaN)] },
  { expires: ["invalid"] },
])("EVCANCEL-05 refuses unusable authority input %j", async ({ expires }) => {
  const f = fixture();
  expect(
    await eventCancellationTransaction(f.pool, false, async (tx) => {
      await tx.observe(expires as Date[]);
      return () => "not exposed";
    }),
  ).toEqual({ kind: "unavailable" });
});
it.each([
  undefined,
  { remaining: 2, observed: instant },
  { remaining: " ", observed: instant },
  { remaining: "NaN", observed: instant },
  { remaining: "2000", observed: "invalid" },
  { remaining: "2000", observed: new Date(NaN) },
])(
  "EVCANCEL-05 refuses invalid database lifetime observations %j",
  async (row) => {
    const f = fixture();
    f.state.row = row;
    expect(await read(f.pool)).toEqual({ kind: "unavailable" });
  },
);
it.each(["0", "-1"])(
  "EVCANCEL-05 refuses already-expired authority (%s milliseconds)",
  async (remaining) => {
    const f = fixture();
    f.state.row = { remaining, observed: instant };
    expect(await read(f.pool)).toEqual({ kind: "denied" });
    expect(f.statements).not.toContain("COMMIT");
  },
);
it("EVCANCEL-05 rechecks lifetime after the result projection before issuing commit", async () => {
  const f = fixture();
  expect(
    await eventCancellationTransaction(f.pool, true, async (tx) => {
      await tx.observe([instant]);
      return () => {
        vi.advanceTimersByTime(2000);
        return "not exposed";
      };
    }),
  ).toEqual({ kind: "denied" });
  expect(f.statements).not.toContain("COMMIT");
});
it.each([false, true])(
  "EVCANCEL-05 discards a late acquired connection even when discard itself fails (%s)",
  async (throws) => {
    const f = fixture();
    f.state.releaseError = throws;
    const pool = {
      connect: () =>
        new Promise((resolve) => setTimeout(() => resolve(f.client), 4000)),
    } as unknown as Pool;
    expect(await advance(read(pool), 3001)).toEqual({ kind: "unavailable" });
    expect(f.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.statements).toEqual([]);
  },
);
it.each([false, true])(
  "EVCANCEL-05 rejects a connection handed back beyond acquisition bound (%s)",
  async (throws) => {
    const f = fixture();
    f.state.releaseError = throws;
    f.connect.mockImplementation(async () => {
      vi.advanceTimersByTime(3000);
      return f.client;
    });
    expect(await read(f.pool)).toEqual({ kind: "unavailable" });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.statements).toEqual([]);
  },
);
it("EVCANCEL-05 handles acquisition failure without a connection", async () => {
  const f = fixture();
  f.connect.mockRejectedValue(Error("private acquisition"));
  expect(await read(f.pool)).toEqual({ kind: "unavailable" });
  expect(f.release).not.toHaveBeenCalled();
});
it.each(["2000", "20000"])(
  "EVCANCEL-05 rejects a late returned query acknowledgement with %s remaining milliseconds even before its timer callback runs",
  async (remaining) => {
    const f = fixture();
    f.state.row = { remaining, observed: instant };
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const query = f.client.query;
    f.client.query = (async (sql: string, values?: unknown[]) => {
      if (sql === "SELECT late acknowledgement") now += 5000;
      return query(sql, values);
    }) as PoolClient["query"];
    expect(
      await eventCancellationTransaction(f.pool, false, async (tx) => {
        await tx.observe([instant]);
        await tx.query("SELECT late acknowledgement");
        return () => "not exposed";
      }),
    ).toEqual({ kind: remaining === "2000" ? "denied" : "unavailable" });
    expect(f.statements).not.toContain("COMMIT");
    expect(f.statements).not.toContain("ROLLBACK");
    expect(f.release).toHaveBeenCalledOnce();
  },
);
