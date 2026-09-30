import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  CIRCLES,
  circleStore,
  disabledCircleStore,
} from "../../src/circles.ts";

it("keeps the fixed local topics cross-audience and noncommercial", async () => {
  expect(CIRCLES.map((circle) => circle.id)).toEqual([
    "everyday-ai",
    "professional-work",
    "technical-practice",
  ]);
  expect(CIRCLES.map((circle) => circle.goal)).toEqual([
    "everyday",
    "work",
    "build",
  ]);
  for (const circle of CIRCLES) {
    expect(circle.capacity).toBe(4);
    expect(circle.description.length).toBeGreaterThan(25);
    expect(circle.description).not.toMatch(/client|paid|recording/i);
  }
  const disabled = disabledCircleStore();
  expect(await disabled.list("token")).toBeNull();
  expect(await disabled.join("token", "everyday-ai")).toBe("denied");
  expect(await disabled.leave("token", "everyday-ai")).toBe(false);
});

it("lists only an active member's own state and aggregate seats", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: "me" }] })
    .mockResolvedValueOnce({
      rows: [{ circle_id: "everyday-ai", member_count: 2, joined: true }],
    });
  const circles = circleStore({ query } as unknown as Pool);
  expect(await circles.list("expired")).toBeNull();
  const rows = await circles.list("member");
  expect(rows).toMatchObject([
    { id: "everyday-ai", joined: true, seatsRemaining: 2 },
    { id: "professional-work", joined: false, seatsRemaining: 4 },
    { id: "technical-practice", joined: false, seatsRemaining: 4 },
  ]);
  expect(query.mock.calls[2]![0]).not.toContain("member_name");
});

function joinPool({
  member = true,
  existing = false,
  count = 0,
  failInsert = false,
  validAtCompletion = true,
} = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT p.id"))
      return {
        rows: member
          ? [{ id: "member-id", expiresAt: "2030-01-01 00:00:00.123456+00" }]
          : [],
      };
    if (sql.includes("SELECT 1 FROM preview_circle_memberships"))
      return { rowCount: existing ? 1 : 0 };
    if (sql.includes("COUNT(*)")) return { rows: [{ n: count }] };
    if (sql.includes("INSERT INTO preview_circle_memberships") && failInsert)
      throw new Error("write failed");
    if (sql.includes("SELECT clock_timestamp()"))
      return { rows: [{ valid: validAtCompletion }] };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  const pool = { connect, query: vi.fn() } as unknown as Pool;
  return { pool, connect, query, release };
}

it("denies unknown or expired joins and preserves idempotent membership", async () => {
  const missing = joinPool();
  expect(await circleStore(missing.pool).join("token", "unknown")).toBe(
    "denied",
  );
  expect(missing.connect).not.toHaveBeenCalled();
  const expired = joinPool({ member: false });
  expect(await circleStore(expired.pool).join("token", "everyday-ai")).toBe(
    "denied",
  );
  expect(expired.query.mock.calls.map((call) => call[0])).toContain("COMMIT");
  expect(expired.release).toHaveBeenCalledOnce();
  const existing = joinPool({ existing: true });
  expect(await circleStore(existing.pool).join("token", "everyday-ai")).toBe(
    "joined",
  );
  expect(
    existing.query.mock.calls.some((call) => call[0].includes("INSERT")),
  ).toBe(false);
});

it("locks the circle before the count, refuses a full circle, and rolls back failed writes", async () => {
  const full = joinPool({ count: 4 });
  expect(await circleStore(full.pool).join("token", "everyday-ai")).toBe(
    "full",
  );
  expect(full.query.mock.calls[1]![0]).toContain("pg_advisory_xact_lock");
  expect(full.query.mock.calls.some((call) => call[0].includes("INSERT"))).toBe(
    false,
  );
  const open = joinPool();
  expect(await circleStore(open.pool).join("token", "everyday-ai")).toBe(
    "joined",
  );
  expect(
    open.query.mock.calls.some((call) => call[0].includes("ON CONFLICT")),
  ).toBe(true);
  const failed = joinPool({ failInsert: true });
  await expect(
    circleStore(failed.pool).join("token", "everyday-ai"),
  ).rejects.toThrow("write failed");
  expect(failed.query.mock.calls.map((call) => call[0])).toContain("ROLLBACK");
  expect(failed.release).toHaveBeenCalledOnce();
});

it.each([
  { state: "new membership", existing: false, count: 0 },
  { state: "repeated join", existing: true, count: 0 },
  { state: "full circle", existing: false, count: 4 },
])("denies an expired $state at completion and rolls back", async (state) => {
  const expired = joinPool({ ...state, validAtCompletion: false });
  expect(await circleStore(expired.pool).join("token", "everyday-ai")).toBe(
    "denied",
  );
  const statements = expired.query.mock.calls.map(([sql]) => sql);
  expect(statements).toContain("ROLLBACK");
  expect(statements).not.toContain("COMMIT");
  expect(statements.some((sql) => sql.includes("INSERT INTO"))).toBe(
    state.state === "new membership",
  );
  expect(expired.release).toHaveBeenCalledOnce();
});

function leavePool({
  member = true,
  workspace = true,
  changed = true,
  validAtCompletion = true,
  failUpdate = false,
  failRollback = false,
} = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && failRollback)
      throw new Error("rollback unavailable");
    if (sql.includes("SELECT p.id"))
      return {
        rows: member
          ? [{ id: "member-id", expiresAt: "2030-01-01 00:00:00+00" }]
          : [],
      };
    if (sql.includes("SELECT id FROM workspaces"))
      return { rows: workspace ? [{ id: "workspace-id" }] : [] };
    if (sql.includes("UPDATE preview_circle_memberships")) {
      if (failUpdate) throw new Error("membership write failed");
      return { rowCount: changed ? 1 : 0 };
    }
    if (sql.includes("SELECT clock_timestamp()"))
      return { rows: [{ valid: validAtCompletion }] };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  const pool = { connect } as unknown as Pool;
  return { pool, query, release, connect };
}

it("leaves only a current member's active membership in a nondeleting workspace", async () => {
  const valid = leavePool();
  expect(await circleStore(valid.pool).leave("token", "unknown")).toBe(false);
  expect(valid.connect).not.toHaveBeenCalled();
  expect(await circleStore(valid.pool).leave("token", "everyday-ai")).toBe(
    true,
  );
  expect(valid.query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
  expect(valid.release).toHaveBeenCalledOnce();

  const repeated = leavePool({ changed: false });
  expect(await circleStore(repeated.pool).leave("token", "everyday-ai")).toBe(
    false,
  );
  const expired = leavePool({ member: false });
  expect(await circleStore(expired.pool).leave("token", "everyday-ai")).toBe(
    false,
  );
  expect(expired.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  const deleting = leavePool({ workspace: false });
  expect(await circleStore(deleting.pool).leave("token", "everyday-ai")).toBe(
    false,
  );
  expect(deleting.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
});

it("rolls back a leave that expires during its membership wait or fails to write", async () => {
  const late = leavePool({ validAtCompletion: false });
  expect(await circleStore(late.pool).leave("token", "everyday-ai")).toBe(
    false,
  );
  expect(late.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(late.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");

  const failed = leavePool({ failUpdate: true });
  await expect(
    circleStore(failed.pool).leave("token", "everyday-ai"),
  ).rejects.toThrow("membership write failed");
  expect(failed.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(failed.release).toHaveBeenCalledOnce();

  const unavailableRollback = leavePool({
    failUpdate: true,
    failRollback: true,
  });
  await expect(
    circleStore(unavailableRollback.pool).leave("token", "everyday-ai"),
  ).rejects.toThrow("membership write failed");
  expect(unavailableRollback.release).toHaveBeenCalledOnce();
  expect(unavailableRollback.release.mock.calls[0]![0]).toBeInstanceOf(Error);
});
