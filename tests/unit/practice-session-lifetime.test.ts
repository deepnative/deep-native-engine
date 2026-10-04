import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "../../src/practice-session-lifetime.ts";
beforeEach(() =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }),
);
afterEach(() => vi.useRealTimers());
function fixture() {
  const state = {
    remaining: "2000",
    valid: true,
    observed: new Date(),
    releaseError: false,
    delayCommit: 0,
    handbackDelay: 0,
    queryError: "",
    never: "",
  };
  const statements: string[] = [],
    release = vi.fn(() => {
      if (state.handbackDelay) vi.advanceTimersByTime(state.handbackDelay);
      if (state.releaseError) throw Error("Disconnected");
    });
  const client = {
    query: (async (sql: string) => {
      statements.push(sql);
      if (sql === state.queryError) throw Error("Query failed");
      if (sql === state.never) return new Promise(() => {});
      if (sql === "COMMIT" && state.delayCommit)
        await new Promise((resolve) => setTimeout(resolve, state.delayCommit));
      return {
        rows: sql.includes("WITH instant")
          ? [
              {
                remaining: state.remaining,
                valid: state.valid,
                observed: state.observed,
              },
            ]
          : [],
      };
    }) as PoolClient["query"],
    release,
  };
  const connect = vi.fn(async () => client);
  return {
    state,
    client,
    statements,
    release,
    connect,
    pool: { connect } as unknown as Pool,
  };
}
const read = (pool: Pool) =>
  practiceTransaction(pool, async (tx) => {
    await tx.observe([new Date()]);
    return { private: "invented" };
  });
async function outcome(promise: Promise<unknown>, advance = 0) {
  const caught = promise.then(
    (value) => ({ value, error: undefined }),
    (error) => ({ value: undefined, error }),
  );
  await vi.advanceTimersByTimeAsync(advance);
  return caught;
}
it("returns the successful fenced result only after COMMIT and owned handback", async () => {
  const f = fixture();
  expect(await read(f.pool)).toEqual({ private: "invented" });
  expect(f.statements.at(-1)).toBe("COMMIT");
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.release.mock.calls[0]).toHaveLength(1);
});
it("withholds a late successful commit", async () => {
  const f = fixture();
  f.state.delayCommit = 2500;
  const result = await outcome(read(f.pool), 2001);
  expect(result.error).toMatchObject({
    kind: "denied",
  });
  expect(f.statements.filter((s) => s === "COMMIT")).toHaveLength(1);
  expect(f.statements).not.toContain("ROLLBACK");
  expect(f.release).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500);
});
it("checks authority after slow handback", async () => {
  const f = fixture();
  f.state.handbackDelay = 2100;
  const result = await outcome(read(f.pool));
  expect(result.error).toMatchObject({
    kind: "denied",
  });
  expect(f.statements).not.toContain("ROLLBACK");
});
it("discards a client that arrives after the acquisition deadline", async () => {
  const f = fixture();
  const pool = {
    connect: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              query: () => {
                throw Error("Must not read");
              },
              release: f.release,
            }),
          4000,
        ),
      ),
  } as unknown as Pool;
  const result = await outcome(read(pool), 3001);
  expect(result.error).toMatchObject({ kind: "unavailable" });
  expect(f.release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.release).toHaveBeenCalledOnce();
});
it("never queues rollback behind an unresolved query", async () => {
  const f = fixture();
  f.state.never = "SELECT private";
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      await tx.query("SELECT private");
      return "never";
    }),
    2001,
  );
  expect(result.error).toMatchObject({ kind: "denied" });
  expect(f.statements).not.toContain("ROLLBACK");
  expect(f.release).toHaveBeenCalledOnce();
});
it("rolls back a known pre-commit error and does not expose its raw message", async () => {
  const f = fixture();
  f.state.queryError = "SELECT private";
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      await tx.query("SELECT private");
      return "never";
    }),
  );
  expect(result.error).toBeInstanceOf(PracticeLifetimeFailure);
  expect(result.error.message).not.toContain("Query failed");
  expect(f.statements.at(-1)).toBe("ROLLBACK");
});
it("does not roll back a commit whose reply failed", async () => {
  const f = fixture();
  f.state.queryError = "COMMIT";
  const result = await outcome(read(f.pool));
  expect(result.error).toMatchObject({ kind: "unavailable" });
  expect(f.statements).not.toContain("ROLLBACK");
});
it("withholds the result if native release throws", async () => {
  const f = fixture();
  f.state.releaseError = true;
  expect((await outcome(read(f.pool))).error).toMatchObject({
    kind: "unavailable",
  });
});
it("refuses a callback that never established database authority", async () => {
  const f = fixture();
  expect(
    (
      await outcome(
        practiceTransaction(f.pool, async () => ({
          private: "unsafe",
        })),
      )
    ).error,
  ).toMatchObject({ kind: "unavailable" });
  expect(f.statements).not.toContain("COMMIT");
});
it.each(["", "NaN", "Infinity"])(
  "rejects malformed remaining duration %j",
  async (remaining) => {
    const f = fixture();
    f.state.remaining = remaining;
    expect((await outcome(read(f.pool))).error).toMatchObject({
      kind: "unavailable",
    });
    expect(f.statements).not.toContain("COMMIT");
  },
);
it("rejects invalid observed clock data", async () => {
  const f = fixture();
  f.state.observed = new Date(NaN);
  expect((await outcome(read(f.pool))).error).toMatchObject({
    kind: "unavailable",
  });
});
it("rejects invalid expiry input before asking the database", async () => {
  for (const expires of [[], [new Date(NaN)]]) {
    const f = fixture();
    expect(
      (
        await outcome(
          practiceTransaction(f.pool, async (tx) => {
            await tx.observe(expires);
            return "unsafe";
          }),
        )
      ).error,
    ).toMatchObject({ kind: "unavailable" });
    expect(f.statements.some((s) => s.includes("WITH instant"))).toBe(false);
  }
});
it("does not extend authority when a later observation has more remaining time", async () => {
  const f = fixture();
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      await tx.bounded(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );
      f.state.remaining = "10000";
      await tx.observe([new Date()]);
      await tx.bounded(
        () => new Promise((resolve) => setTimeout(resolve, 1500)),
      );
      return "unsafe";
    }),
    2001,
  );
  expect(result.error).toMatchObject({ kind: "denied" });
});
it("enforces the whole-operation deadline across otherwise timely stages", async () => {
  const f = fixture();
  f.state.remaining = "60000";
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      for (let i = 0; i < 3; i++)
        await tx.bounded(
          () => new Promise((resolve) => setTimeout(resolve, 4000)),
        );
      return "unsafe";
    }),
    10001,
  );
  expect(result.error).toMatchObject({ kind: "unavailable" });
  expect(f.statements).not.toContain("COMMIT");
  expect(f.statements).not.toContain("ROLLBACK");
});
it("uses the stage bound even when session authority is longer", async () => {
  const f = fixture();
  f.state.remaining = "60000";
  f.state.never = "SELECT private";
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      await tx.query("SELECT private");
      return "unsafe";
    }),
    5001,
  );
  expect(result.error).toMatchObject({ kind: "unavailable" });
  expect(f.statements).not.toContain("ROLLBACK");
});
it("withholds a synchronously delayed result even before the timer callback runs", async () => {
  const f = fixture();
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      return tx.bounded(async () => {
        vi.advanceTimersByTime(2000);
        return "private result";
      });
    }),
  );
  expect(result.error).toMatchObject({ kind: "denied" });
  expect(result.value).toBeUndefined();
  expect(f.statements).not.toContain("COMMIT");
  expect(f.statements).not.toContain("ROLLBACK");
});
it("contains rollback failure and discards the connection without committing", async () => {
  const f = fixture();
  f.state.queryError = "ROLLBACK";
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      throw new PracticeLifetimeFailure("denied");
    }),
  );
  expect(result.error).toMatchObject({ kind: "unavailable" });
  expect(f.statements.at(-1)).toBe("ROLLBACK");
  expect(f.statements).not.toContain("COMMIT");
  expect(f.release).toHaveBeenCalledOnce();
});
it("refuses a database observation explicitly reporting expired authority", async () => {
  const f = fixture();
  f.state.valid = false;
  const result = await outcome(read(f.pool));
  expect(result.error).toMatchObject({ kind: "denied" });
  expect(result.value).toBeUndefined();
  expect(f.statements).not.toContain("COMMIT");
});
it("does not commit after callback work exhausts authority outside a query", async () => {
  const f = fixture();
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      vi.advanceTimersByTime(2000);
      return "private result";
    }),
  );
  expect(result.error).toMatchObject({ kind: "denied" });
  expect(f.statements).not.toContain("COMMIT");
  expect(f.release).toHaveBeenCalledOnce();
});
it.each([false, true])(
  "discards a client whose acquisition blocks past the deadline, release throws=%s",
  async (throws) => {
    const f = fixture();
    f.state.releaseError = throws;
    const pool = {
      connect: async () => {
        vi.advanceTimersByTime(3001);
        return { query: vi.fn(), release: f.release };
      },
    } as unknown as Pool;
    const result = await outcome(read(pool));
    expect(result.error).toMatchObject({ kind: "unavailable" });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.statements).toHaveLength(0);
  },
);
it("refuses another stage after callback work exhausts the whole deadline", async () => {
  const f = fixture();
  f.state.remaining = "60000";
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      vi.advanceTimersByTime(10001);
      return tx.bounded(async () => "must not disclose");
    }),
  );
  expect(result.error).toMatchObject({ kind: "unavailable" });
  expect(f.statements).not.toContain("COMMIT");
});
it("withholds a synchronous stage result when elapsed time advances before timers can fire", async () => {
  const f = fixture();
  let advanced = false;
  const now = vi.spyOn(performance, "now");
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      return tx.bounded(async () => {
        advanced = true;
        now.mockReturnValue(2500);
        return "private";
      });
    }),
  );
  expect(advanced).toBe(true);
  expect(result.error).toMatchObject({ kind: "denied" });
  expect(f.statements).not.toContain("COMMIT");
  expect(f.statements).not.toContain("ROLLBACK");
  now.mockRestore();
});
it("withholds a synchronous stage that exceeds its own bound despite longer authority", async () => {
  const f = fixture();
  f.state.remaining = "60000";
  const now = vi.spyOn(performance, "now");
  try {
    const result = await outcome(
      practiceTransaction(f.pool, async (tx) => {
        await tx.observe([new Date()]);
        return tx.bounded(async () => {
          now.mockReturnValue(5001);
          return "private";
        });
      }),
    );
    expect(result.error).toMatchObject({ kind: "unavailable" });
    expect(f.statements).not.toContain("COMMIT");
    expect(f.statements).not.toContain("ROLLBACK");
  } finally {
    now.mockRestore();
  }
});

it.each([
  { remaining: "0" },
  { remaining: "-1" },
  { remaining: "   " },
  { remaining: null },
  { remaining: 1000 },
  { observed: "2026-01-01" },
  { valid: "yes" },
])("rejects unusable PostgreSQL lifetime data %j", async (invalid) => {
  const f = fixture();
  Object.assign(f.state, invalid);
  const result = await outcome(read(f.pool));
  expect(result.error).toBeInstanceOf(PracticeLifetimeFailure);
  expect(result.value).toBeUndefined();
  expect(f.statements).not.toContain("COMMIT");
  expect(f.release).toHaveBeenCalledOnce();
});
it("rejects a missing PostgreSQL clock observation", async () => {
  const f = fixture(),
    original = f.client.query;
  f.client.query = (async (sql: string) =>
    sql.includes("WITH instant")
      ? { rows: [] }
      : original(sql)) as PoolClient["query"];
  const result = await outcome(read(f.pool));
  expect(result.error).toMatchObject({ kind: "unavailable" });
  expect(f.statements).not.toContain("COMMIT");
});
it("bounds an unresolved known rollback and releases only its owned client", async () => {
  const f = fixture();
  f.state.never = "ROLLBACK";
  const result = await outcome(
    practiceTransaction(f.pool, async (tx) => {
      await tx.observe([new Date()]);
      throw new PracticeLifetimeFailure("denied");
    }),
    2001,
  );
  expect(result.value).toBeUndefined();
  expect(f.statements.filter((s) => s === "ROLLBACK")).toHaveLength(1);
  expect(f.statements).not.toContain("COMMIT");
  expect(f.release).toHaveBeenCalledOnce();
});
it("contains a release error on an asynchronously late acquired connection", async () => {
  const f = fixture();
  f.state.releaseError = true;
  f.connect.mockImplementationOnce(
    () => new Promise((resolve) => setTimeout(() => resolve(f.client), 4000)),
  );
  const result = await outcome(read(f.pool), 3001);
  expect(result.error).toMatchObject({ kind: "unavailable" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.statements).toHaveLength(0);
});
