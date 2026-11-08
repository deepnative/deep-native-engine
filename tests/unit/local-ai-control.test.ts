import type { Pool, PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import {
  localAiControlStore,
  localAiEnabled,
  validCeilingChange,
} from "../../src/local-ai-control.ts";
function fixture(
  options: {
    row?: unknown;
    missing?: boolean;
    denied?: boolean;
    expired?: boolean;
    fail?: string;
    broken?: boolean;
    connectFail?: boolean;
    ceiling?: Record<string, unknown> | null;
    earlier?: Record<string, unknown>;
    history?: Record<string, unknown>[];
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (options.fail && sql.includes(options.fail))
      throw Error("private DB detail");
    if (sql === "ROLLBACK" && options.broken)
      throw Error("private rollback detail");
    if (sql.includes("SELECT paused"))
      return {
        rows: options.missing
          ? []
          : [{ paused: options.row === undefined ? false : options.row }],
      };
    if (sql.includes("FROM ai_test_spending_ceiling_changes WHERE"))
      return { rows: options.earlier ? [options.earlier] : [] };
    if (sql.includes("FROM ai_test_spending_ceiling_changes ORDER"))
      return { rows: options.history ?? [] };
    if (sql.includes("FROM ai_test_spending_ceiling"))
      return {
        rows:
          options.ceiling === null
            ? []
            : [
                options.ceiling ?? {
                  rate_version: "simulated-rates-v1",
                  ceiling_points: "5000",
                  committed_points: "157",
                },
              ],
      };
    if (sql.includes("SELECT p.id"))
      return {
        rows:
          options.denied || (options.expired && !sql.includes("FOR SHARE"))
            ? []
            : [{ id: "admin" }],
      };
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => {
    if (options.connectFail) throw Error("private connection detail");
    return client;
  });
  return {
    service: localAiControlStore({ connect } as unknown as Pool),
    query,
    release,
    client,
  };
}
it("reports persisted safe switch state and allows authorized repeat changes", async () => {
  for (const paused of [true, false]) {
    const { service, query, client } = fixture({ row: paused });
    expect(await service.current()).toBe(paused ? "paused" : "enabled");
    expect(await service.read("admin")).toEqual({ paused });
    expect(await service.set("admin", paused)).toBe(true);
    expect(await service.set("admin", paused)).toBe(true);
    expect(query).toHaveBeenCalledWith(
      "UPDATE local_ai_control SET paused=$1 WHERE singleton=true",
      [paused],
    );
    expect(await localAiEnabled(client)).toBe(!paused);
  }
});
it("absent, invalid and unavailable state fails closed with safe return values", async () => {
  for (const options of [
    { missing: true },
    { row: "false" },
    { row: null },
    { fail: "SELECT paused" },
    { connectFail: true },
    { fail: "BEGIN", broken: true },
    { fail: "COMMIT" },
  ]) {
    const { service, release, client } = fixture(options);
    expect(await service.current()).toBe("unavailable");
    expect(await service.read("admin")).toBeNull();
    expect(await service.set("admin", true)).toBe(false);
    if ("missing" in options || "row" in options)
      expect(await localAiEnabled(client)).toBe(false);
    if ("broken" in options) expect(release).toHaveBeenCalledWith(true);
  }
});
it("denies invalid booleans, unauthorized and expired admin without mutation", async () => {
  for (const options of [{ denied: true }, { expired: true }]) {
    const { service, query } = fixture(options);
    expect(await service.read("member")).toBeNull();
    expect(await service.set("member", true)).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  }
  const { service, query } = fixture();
  expect(await service.set("admin", "false" as unknown as boolean)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it("gives platform admins content-free spending totals and fails closed otherwise", async () => {
  expect(await fixture().service.spending("admin")).toEqual({
    rateVersion: "simulated-rates-v1",
    ceilingPoints: 5000,
    committedPoints: 157,
    remainingPoints: 4843,
  });
  // An overrun past the ceiling shows no negative room.
  expect(
    await fixture({
      ceiling: {
        rate_version: "simulated-rates-v1",
        ceiling_points: "100",
        committed_points: "3600",
      },
    }).service.spending("admin"),
  ).toMatchObject({ committedPoints: 3600, remainingPoints: 0 });
  const denied = fixture({ denied: true });
  expect(await denied.service.spending("member")).toBeNull();
  expect(
    denied.query.mock.calls.some(([sql]) =>
      (sql as string).includes("ai_test_spending_ceiling"),
    ),
  ).toBe(false);
  expect(await fixture({ ceiling: null }).service.spending("admin")).toBeNull();
  expect(
    await fixture({ fail: "ai_test_spending_ceiling" }).service.spending(
      "admin",
    ),
  ).toBeNull();
});

const KEY = "4f9c2a51-3b7e-4d2a-9c11-0a7b5e6f8d21";
const inserted = (query: ReturnType<typeof fixture>["query"]) =>
  query.mock.calls.filter(([sql]) =>
    (sql as string).startsWith("INSERT INTO ai_test_spending_ceiling_changes"),
  );

it("AICTL: records a platform admin's test ceiling change against the value they saw", async () => {
  const { service, query } = fixture();
  expect(
    await service.setCeiling("admin", {
      expectedPoints: 5000,
      ceilingPoints: 0,
      key: KEY,
    }),
  ).toEqual({ kind: "changed" });
  expect(inserted(query)).toEqual([
    [expect.any(String), ["admin", KEY, "simulated-rates-v1", 5000, 0, "157"]],
  ]);
  // Another administrator moved it first: nothing is written.
  const stale = fixture();
  expect(
    await stale.service.setCeiling("admin", {
      expectedPoints: 4000,
      ceilingPoints: 6000,
      key: KEY,
    }),
  ).toEqual({ kind: "stale" });
  expect(inserted(stale.query)).toEqual([]);
});

it("AICTL: replays a resubmitted change once and refuses a reused key with other values", async () => {
  const earlier = { previous_points: "5000", ceiling_points: "9000" };
  for (const [request, kind] of [
    [{ expectedPoints: 5000, ceilingPoints: 9000 }, "replayed"],
    [{ expectedPoints: 5000, ceilingPoints: 9001 }, "conflict"],
    [{ expectedPoints: 4999, ceilingPoints: 9000 }, "conflict"],
  ] as const) {
    const { service, query } = fixture({ earlier });
    expect(await service.setCeiling("admin", { ...request, key: KEY })).toEqual(
      { kind },
    );
    expect(inserted(query)).toEqual([]);
  }
});

it("AICTL: refuses invalid values before the database and fails closed without authority", async () => {
  for (const [expectedPoints, ceilingPoints, key] of [
    [5000, -1, KEY],
    [5000, 1.5, KEY],
    [5000, Number.NaN, KEY],
    [5000, 1_000_000_000_001, KEY],
    [5000, 5000, KEY],
    [-1, 0, KEY],
    [5000, 1, "not-a-key"],
    [5000, 1, 7 as unknown as string],
  ] as const) {
    const { service, query } = fixture();
    expect(
      await service.setCeiling("admin", { expectedPoints, ceilingPoints, key }),
    ).toEqual({ kind: "invalid" });
    expect(query).not.toHaveBeenCalled();
  }
  expect(
    validCeilingChange({
      expectedPoints: 0,
      ceilingPoints: 1_000_000_000_000,
      key: KEY,
    }),
  ).toBe(true);
  for (const options of [
    { denied: true },
    { expired: true },
    { ceiling: null },
    { fail: "INSERT INTO ai_test_spending_ceiling_changes" },
    { connectFail: true },
  ]) {
    const { service } = fixture(options);
    expect(
      await service.setCeiling("admin", {
        expectedPoints: 5000,
        ceilingPoints: 1,
        key: KEY,
      }),
    ).toEqual({ kind: "denied" });
  }
});

it("AICTL: shows platform admins the content-free change history, newest first", async () => {
  const changedAt = new Date("2026-11-08T12:00:00Z");
  const { service } = fixture({
    history: [
      {
        changed_at: changedAt,
        rate_version: "simulated-rates-v1",
        previous_points: "5000",
        ceiling_points: "0",
        committed_points: "157",
      },
    ],
  });
  expect(await service.ceilingHistory("admin")).toEqual([
    {
      changedAt,
      rateVersion: "simulated-rates-v1",
      previousPoints: 5000,
      ceilingPoints: 0,
      committedPoints: 157,
    },
  ]);
  expect(await fixture().service.ceilingHistory("admin")).toEqual([]);
  expect(
    await fixture({ denied: true }).service.ceilingHistory("member"),
  ).toBeNull();
});
