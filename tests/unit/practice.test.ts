import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { disabledPracticeStore, practiceStore } from "../../src/practice.ts";
import { hash } from "../../src/store.ts";

it("leaves private practice unavailable until the database store is wired", async () => {
  const disabled = disabledPracticeStore();
  expect(await disabled.current("token", "SYN-130")).toBeNull();
  expect(await disabled.history("token")).toEqual([]);
  expect(await disabled.save("token", "SYN-130", 1, "sample")).toBe(
    "unavailable",
  );
});

function mockPool({
  source = true,
  inserted = true,
  existing = "sample",
  fail = false,
}: {
  source?: boolean;
  inserted?: boolean;
  existing?: string | null;
  fail?: boolean;
} = {}) {
  const query = vi.fn(
    async (
      sql: string,
      _params?: unknown[],
    ): Promise<{ rows?: Record<string, unknown>[]; rowCount?: number }> => {
      if (sql.includes("SELECT l.id AS"))
        return {
          rows: source ? [{ memberId: "member-id", goal: "work" }] : [],
        };
      if (sql.includes("INSERT INTO private_practice")) {
        if (fail) throw new Error("database unavailable");
        return { rowCount: inserted ? 1 : 0 };
      }
      if (sql.includes("SELECT response FROM private_practice"))
        return { rows: existing === null ? [] : [{ response: existing }] };
      return { rows: [], rowCount: 0 };
    },
  );
  const release = vi.fn();
  const pool = {
    query,
    connect: vi.fn().mockResolvedValue({ query, release }),
  } as unknown as Pool;
  return { pool, query, release };
}

it("reads only an active member's eligible source and own versioned note", async () => {
  const mocked = mockPool();
  const practice = practiceStore(mocked.pool);
  expect(await practice.current("token", "SYN-130")).toBeNull();
  expect(await practice.history("token")).toEqual([]);
  const query = mocked.query;
  query.mockResolvedValueOnce({
    rows: [{ id: "SYN-130", version: 1, response: "sample" }],
  });
  expect(await practice.current("token", "SYN-130")).toMatchObject({
    response: "sample",
  });
  query.mockResolvedValueOnce({ rows: [{ id: "SYN-130", available: false }] });
  expect(await practice.history("token")).toMatchObject([{ available: false }]);
  expect(query.mock.calls[0]![1]).toEqual([hash("token"), "SYN-130"]);
  expect(query.mock.calls[1]![0]).toContain("l.id=pp.member_id");
});

it("makes the first version-pinned save win, permits exact replay and rejects stale writes", async () => {
  const first = mockPool();
  expect(
    await practiceStore(first.pool).save("token", "SYN-130", 1, "sample"),
  ).toBe("saved");
  expect(
    first.query.mock.calls.find((call) => call[0].includes("INSERT INTO"))![1],
  ).toEqual(["member-id", "SYN-130", 1, "work", "sample"]);
  expect(first.release).toHaveBeenCalledOnce();
  const replay = mockPool({ inserted: false });
  expect(
    await practiceStore(replay.pool).save("token", "SYN-130", 1, "sample"),
  ).toBe("replayed");
  const stale = mockPool({ inserted: false, existing: "newer" });
  expect(
    await practiceStore(stale.pool).save("token", "SYN-130", 1, "sample"),
  ).toBe("conflict");
  const missing = mockPool({ inserted: false, existing: null });
  expect(
    await practiceStore(missing.pool).save("token", "SYN-130", 1, "sample"),
  ).toBe("conflict");
  const unavailable = mockPool({ source: false });
  expect(
    await practiceStore(unavailable.pool).save("token", "SYN-130", 1, "sample"),
  ).toBe("unavailable");
  expect(unavailable.query.mock.calls.map((call) => call[0])).toContain(
    "ROLLBACK",
  );
  const failed = mockPool({ fail: true });
  await expect(
    practiceStore(failed.pool).save("token", "SYN-130", 1, "sample"),
  ).rejects.toThrow("database unavailable");
  expect(failed.query.mock.calls.map((call) => call[0])).toContain("ROLLBACK");
  expect(failed.release).toHaveBeenCalledOnce();
});
