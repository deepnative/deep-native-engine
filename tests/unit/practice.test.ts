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
  expect(await disabled.withdraw("token", "SYN-130", 1)).toBe("unavailable");
});
function mockPool({
  principal = true,
  workspace = true,
  source = true,
  inserted = true,
  existing = "sample",
  withdrawn = false,
  valid = true,
  failAt = "",
  rollbackFails = false,
}: {
  principal?: boolean;
  workspace?: boolean;
  source?: boolean;
  inserted?: boolean;
  existing?: string | null;
  withdrawn?: boolean;
  valid?: boolean;
  failAt?: string;
  rollbackFails?: boolean;
} = {}) {
  const query = vi.fn(
    async (
      sql: string,
      _params?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }> => {
      if (
        (failAt && sql.includes(failAt)) ||
        (rollbackFails && sql === "ROLLBACK")
      )
        throw Error("database unavailable");
      if (sql.startsWith("SELECT id,expires_at"))
        return {
          rows: principal
            ? [{ id: "member-id", expires_at: new Date("2100-01-01") }]
            : [],
        };
      if (sql.startsWith("SELECT id FROM workspaces"))
        return { rows: workspace ? [{ id: "workspace-id" }] : [] };
      if (sql.startsWith("SELECT l.goal"))
        return { rows: source ? [{ goal: "work" }] : [] };
      if (sql.includes("INSERT INTO private_practice"))
        return { rows: [], rowCount: inserted ? 1 : 0 };
      if (sql.includes("FROM private_practice") && !sql.includes("JOIN"))
        return {
          rows:
            existing === null
              ? []
              : [
                  {
                    response: existing,
                    withdrawnAt: withdrawn ? new Date("2026-01-01") : null,
                  },
                ],
        };
      if (sql.includes("AS valid")) return { rows: [{ valid }] };
      return { rows: [], rowCount: 0 };
    },
  );
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return {
    pool: { query, connect } as unknown as Pool,
    query,
    release,
    connect,
  };
}
it("reads only the active member's eligible source and own retained versioned notes", async () => {
  const mocked = mockPool();
  const practice = practiceStore(mocked.pool);
  expect(await practice.current("token", "SYN-130")).toBeNull();
  expect(await practice.history("token")).toEqual([]);
  mocked.query.mockResolvedValueOnce({
    rows: [
      { id: "SYN-130", version: 1, response: null, withdrawnAt: new Date() },
    ],
  });
  expect(await practice.current("token", "SYN-130")).toMatchObject({
    response: null,
    withdrawnAt: expect.any(Date),
  });
  mocked.query.mockResolvedValueOnce({
    rows: [{ id: "SYN-130", available: false, response: null }],
  });
  expect(await practice.history("token")).toMatchObject([
    { available: false, response: null },
  ]);
  expect(mocked.query.mock.calls[0]![1]).toEqual([hash("token"), "SYN-130"]);
  expect(mocked.query.mock.calls[1]![0]).toContain("l.id=pp.member_id");
});
it.each([
  [{}, "saved"],
  [{ inserted: false }, "replayed"],
  [{ inserted: false, existing: "newer" }, "conflict"],
  [{ inserted: false, existing: null }, "conflict"],
  [{ inserted: false, withdrawn: true }, "withdrawn"],
  [{ source: false }, "unavailable"],
] as const)(
  "preserves first-save/replay/withdrawn behavior for %j",
  async (options, result) => {
    const mocked = mockPool(options);
    expect(
      await practiceStore(mocked.pool).save("token", "SYN-130", 1, "sample"),
    ).toBe(result);
    expect(mocked.release).toHaveBeenCalledOnce();
  },
);
it.each([
  [{}, "withdrawn"],
  [{ withdrawn: true }, "already-withdrawn"],
  [{ existing: null }, "unavailable"],
] as const)(
  "withdraws or reports the retained state for %j",
  async (options, result) => {
    const mocked = mockPool(options);
    expect(
      await practiceStore(mocked.pool).withdraw("token", "SYN-130", 1),
    ).toBe(result);
    expect(
      mocked.query.mock.calls.filter((call) =>
        call[0].startsWith("UPDATE private_practice"),
      ),
    ).toHaveLength(result === "withdrawn" ? 1 : 0);
  },
);
it.each(["save", "withdraw"] as const)(
  "denies %s without an active principal, nondeleting workspace, or unexpired session",
  async (method) => {
    for (const options of [
      { principal: false },
      { workspace: false },
      { valid: false },
    ]) {
      const mocked = mockPool(options);
      expect(
        await practiceStore(mocked.pool)[method](
          "token",
          "SYN-130",
          1,
          "sample",
        ),
      ).toBe("unavailable");
      expect(mocked.query.mock.calls.map((call) => call[0])).toContain(
        "ROLLBACK",
      );
      expect(mocked.query.mock.calls.map((call) => call[0])).not.toContain(
        "COMMIT",
      );
      expect(mocked.release).toHaveBeenCalledWith(undefined);
    }
  },
);
it.each(["save", "withdraw"] as const)(
  "rejects malformed exact keys before %s storage access",
  async (method) => {
    const mocked = mockPool();
    for (const [id, version] of [
      ["forged", 1],
      ["SYN-130", 0],
      ["SYN-130", 1.5],
      ["SYN-130", 2147483648],
      ["SYN-130", NaN],
    ] as const)
      expect(
        await practiceStore(mocked.pool)[method](
          "token",
          id,
          version,
          "sample",
        ),
      ).toBe("unavailable");
    expect(mocked.connect).not.toHaveBeenCalled();
  },
);
it.each(["INSERT INTO private_practice", "UPDATE private_practice", "COMMIT"])(
  "rolls back a failed %s and preserves the unknown outcome",
  async (failAt) => {
    const mocked = mockPool({ failAt });
    const practice = practiceStore(mocked.pool);
    await expect(
      failAt.startsWith("INSERT")
        ? practice.save("token", "SYN-130", 1, "sample")
        : practice.withdraw("token", "SYN-130", 1),
    ).rejects.toThrow("database unavailable");
    expect(mocked.query.mock.calls.map((call) => call[0])).toContain(
      "ROLLBACK",
    );
    expect(mocked.release).toHaveBeenCalledWith(undefined);
  },
);
it("discards a connection whose rollback fails", async () => {
  const mocked = mockPool({
    failAt: "UPDATE private_practice",
    rollbackFails: true,
  });
  await expect(
    practiceStore(mocked.pool).withdraw("token", "SYN-130", 1),
  ).rejects.toThrow("database unavailable");
  expect(mocked.release).toHaveBeenCalledWith(expect.any(Error));
});
it("surfaces connection failures without claiming a withdrawal", async () => {
  const mocked = mockPool();
  mocked.connect.mockRejectedValueOnce(Error("connection failed"));
  await expect(
    practiceStore(mocked.pool).withdraw("token", "SYN-130", 1),
  ).rejects.toThrow("connection failed");
});
