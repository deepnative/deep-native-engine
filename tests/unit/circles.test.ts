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

function listPool({
  member = true,
  workspace = true,
  validAtCompletion = true,
  failure = "",
  failRollback = false,
} = {}) {
  const error = new Error("synthetic list failure");
  let observations = 0;
  const query = vi.fn(async (sql: string) => {
    if (
      (failure === "begin" && sql.startsWith("BEGIN")) ||
      (failure === "principal" && sql.includes("SELECT p.id")) ||
      (failure === "workspace" && sql.includes("SELECT id FROM workspaces")) ||
      (failure === "aggregate" && sql.includes("COUNT(*)")) ||
      (failure === "expiry" && sql.includes("WITH instant AS MATERIALIZED")) ||
      (failure === "commit" && sql === "COMMIT")
    )
      throw error;
    if (failRollback && sql === "ROLLBACK")
      throw new Error("rollback unavailable");
    if (sql.includes("SELECT p.id"))
      return {
        rows: member
          ? [{ id: "me", expires_at: new Date("2030-01-01T00:00:00Z") }]
          : [],
      };
    if (sql.includes("SELECT id FROM workspaces"))
      return { rows: workspace ? [{ id: "owned-workspace" }] : [] };
    if (sql.includes("COUNT(*)"))
      return {
        rows: [{ circle_id: "everyday-ai", member_count: 2, joined: true }],
      };
    if (sql.includes("WITH instant AS MATERIALIZED"))
      return {
        rows: [
          {
            valid: ++observations === 1 || validAtCompletion,
            remaining: "60000",
            observed: new Date(),
          },
        ],
      };
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return {
    pool: { connect } as unknown as Pool,
    query,
    release,
    connect,
    error,
  };
}

it("lists only an active member's own state and aggregate seats", async () => {
  const active = listPool();
  expect(await circleStore(active.pool).list("member")).toMatchObject([
    { id: "everyday-ai", joined: true, seatsRemaining: 2 },
    { id: "professional-work", joined: false, seatsRemaining: 4 },
    { id: "technical-practice", joined: false, seatsRemaining: 4 },
  ]);
  expect(active.query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
  expect(active.release).toHaveBeenCalledOnce();
  expect(active.release).toHaveBeenCalledWith(expect.any(Error));
});

it.each([
  { state: "missing principal", member: false },
  { state: "deleting or missing owned workspace", workspace: false },
  { state: "expired at completion", validAtCompletion: false },
])("withholds a listing for $state", async (options) => {
  const denied = listPool(options);
  expect(await circleStore(denied.pool).list("member")).toBeNull();
  const sql = denied.query.mock.calls.map(([statement]) => statement);
  expect(sql).toContain("ROLLBACK");
  expect(sql).not.toContain("COMMIT");
  if (options.validAtCompletion !== false)
    expect(sql.some((statement) => statement.includes("COUNT(*)"))).toBe(false);
  expect(denied.release).toHaveBeenCalledOnce();
});

it.each(["begin", "principal", "workspace", "aggregate", "expiry", "commit"])(
  "does not return a partial listing or replay after a %s failure",
  async (failure) => {
    const failed = listPool({ failure });
    expect(await circleStore(failed.pool).list("member")).toBeNull();
    expect(failed.connect).toHaveBeenCalledOnce();
    if (failure !== "begin" && failure !== "commit")
      expect(failed.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(failed.release).toHaveBeenCalledOnce();
    expect(failed.release).toHaveBeenCalledWith(expect.any(Error));
  },
);

it("discards a failed listing connection when rollback is unavailable", async () => {
  const failed = listPool({ failure: "aggregate", failRollback: true });
  expect(await circleStore(failed.pool).list("member")).toBeNull();
  expect(failed.release).toHaveBeenCalledOnce();
  expect(failed.release).toHaveBeenCalledWith(expect.any(Error));
  expect(failed.connect).toHaveBeenCalledOnce();
});

function joinPool({
  member = true,
  workspace = true,
  failWorkspace = false,
  failRollback = false,
  failCommit = false,
  existing = false,
  count = 0,
  failInsert = false,
  validAtCompletion = true,
} = {}) {
  let observations = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && failRollback)
      throw new Error("rollback unavailable");
    if (sql === "COMMIT" && failCommit) throw new Error("commit unavailable");
    if (sql.includes("SELECT id FROM workspaces")) {
      if (failWorkspace) throw new Error("workspace read failed");
      return { rows: workspace ? [{ id: "workspace-id" }] : [] };
    }
    if (sql.includes("SELECT p.id"))
      return {
        rows: member
          ? [{ id: "member-id", expires_at: new Date("2030-01-01T00:00:00Z") }]
          : [],
      };
    if (sql.includes("SELECT 1 FROM preview_circle_memberships"))
      return { rowCount: existing ? 1 : 0 };
    if (sql.includes("COUNT(*)")) return { rows: [{ n: count }] };
    if (sql.includes("INSERT INTO preview_circle_memberships") && failInsert)
      throw new Error("write failed");
    if (sql.includes("WITH instant AS MATERIALIZED"))
      return {
        rows: [
          {
            valid: ++observations === 1 || validAtCompletion,
            remaining: "60000",
            observed: new Date(),
          },
        ],
      };
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
  expect(expired.query.mock.calls.map((call) => call[0])).toContain("ROLLBACK");
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
  const statements = full.query.mock.calls.map(([sql]) => sql);
  expect(
    statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock")),
  ).toBeLessThan(statements.findIndex((sql) => sql.includes("COUNT(*)")));
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
  ).rejects.toThrow("Circle operation unconfirmed");
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
  let observations = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && failRollback)
      throw new Error("rollback unavailable");
    if (sql.includes("SELECT p.id"))
      return {
        rows: member
          ? [{ id: "member-id", expires_at: new Date("2030-01-01T00:00:00Z") }]
          : [],
      };
    if (sql.includes("SELECT id FROM workspaces"))
      return { rows: workspace ? [{ id: "workspace-id" }] : [] };
    if (sql.includes("UPDATE preview_circle_memberships")) {
      if (failUpdate) throw new Error("membership write failed");
      return { rowCount: changed ? 1 : 0 };
    }
    if (sql.includes("WITH instant AS MATERIALIZED"))
      return {
        rows: [
          {
            valid: ++observations === 1 || validAtCompletion,
            remaining: "60000",
            observed: new Date(),
          },
        ],
      };
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
  ).rejects.toThrow("Circle operation unconfirmed");
  expect(failed.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(failed.release).toHaveBeenCalledOnce();

  const unavailableRollback = leavePool({
    failUpdate: true,
    failRollback: true,
  });
  await expect(
    circleStore(unavailableRollback.pool).leave("token", "everyday-ai"),
  ).rejects.toThrow("Circle operation unconfirmed");
  expect(unavailableRollback.release).toHaveBeenCalledOnce();
  expect(unavailableRollback.release.mock.calls[0]![0]).toBeInstanceOf(Error);
});

it("denies a missing or deleting owned workspace before inspecting or changing membership", async () => {
  const missing = joinPool({ workspace: false });
  expect(await circleStore(missing.pool).join("token", "everyday-ai")).toBe(
    "denied",
  );
  const sql = missing.query.mock.calls.map(([statement]) => statement);
  expect(sql).toContain("ROLLBACK");
  expect(sql).not.toContain("COMMIT");
  expect(
    sql.some((statement) => statement.includes("preview_circle_memberships")),
  ).toBe(false);
  expect(missing.release).toHaveBeenCalledOnce();
});
it.each([
  {
    failure: "workspace",
    failWorkspace: true,
    failInsert: false,
    failRollback: false,
    failCommit: false,
    discard: false,
    message: "workspace read failed",
  },
  {
    failure: "rollback",
    failWorkspace: false,
    failInsert: true,
    failRollback: true,
    failCommit: false,
    discard: true,
    message: "write failed",
  },
  {
    failure: "commit",
    failWorkspace: false,
    failInsert: false,
    failRollback: false,
    failCommit: true,
    discard: true,
    message: "commit unavailable",
  },
])(
  "preserves a $failure failure and never retries a circle mutation",
  async (options) => {
    const failed = joinPool(options);
    await expect(
      circleStore(failed.pool).join("token", "everyday-ai"),
    ).rejects.toThrow("Circle operation unconfirmed");
    expect(failed.connect).toHaveBeenCalledOnce();
    expect(failed.release).toHaveBeenCalledOnce();
    expect(
      failed.query.mock.calls.filter(([sql]) =>
        sql.includes("INSERT INTO preview_circle_memberships"),
      ),
    ).toHaveLength(options.failWorkspace ? 0 : 1);
    expect(failed.release.mock.calls[0]![0]).toBeInstanceOf(Error);
  },
);
