import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { attemptStore, disabledAttemptStore } from "../../src/attempts.ts";
import { hash } from "../../src/store.ts";

it("keeps attempts disabled unless a real store is wired", async () => {
  const disabled = disabledAttemptStore();
  expect(await disabled.list("token")).toEqual([]);
  expect(await disabled.detail("token", "id")).toBeNull();
  expect(await disabled.start("token")).toBeNull();
  expect(await disabled.save("token", "id", 1, "draft")).toBe(false);
  expect(await disabled.submit("token", "id", 1)).toBe(false);
  expect(await disabled.revise("token", "id")).toBe(false);
  expect(await disabled.remove("token", "id")).toBe(false);
});

it("scopes every operation to a hashed session, member and pinned content", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const attempts = attemptStore({ query } as unknown as Pool);
  const credential = "a".repeat(64);
  expect(await attempts.list(credential)).toEqual([]);
  expect(await attempts.detail(credential, "attempt-id")).toBeNull();
  expect(await attempts.start(credential)).toBeNull();
  expect(await attempts.save(credential, "attempt-id", 1, "draft")).toBe(false);
  expect(await attempts.submit(credential, "attempt-id", 1)).toBe(false);
  expect(await attempts.revise(credential, "attempt-id")).toBe(false);
  expect(query.mock.calls.map((call) => call[1][0])).toEqual(
    Array.from({ length: 6 }, () => hash(credential)),
  );
  expect(query.mock.calls[2]![0]).toContain(
    "ON CONFLICT(member_id,content_id,content_version)",
  );
  expect(query.mock.calls[3]![0]).toContain("a.revision=$3");
  expect(query.mock.calls[4]![0]).toContain("a.saved_at IS NOT NULL");
  expect(query.mock.calls[5]![0]).toContain(
    "a.submission_count BETWEEN 1 AND 9",
  );
  query.mockResolvedValueOnce({ rows: [{ id: "owned" }] });
  expect(await attempts.start(credential)).toBe("owned");
  query.mockResolvedValueOnce({ rows: [{ id: "owned", revision: 2 }] });
  expect(await attempts.detail(credential, "owned")).toMatchObject({
    id: "owned",
    revision: 2,
  });
  query.mockResolvedValueOnce({ rows: [{ id: "owned" }] });
  expect(await attempts.list(credential)).toEqual([{ id: "owned" }]);
  query.mockResolvedValue({ rowCount: 1 });
  expect(await attempts.save(credential, "owned", 2, "draft")).toBe(true);
  expect(await attempts.submit(credential, "owned", 2)).toBe(true);
  expect(await attempts.revise(credential, "owned")).toBe(true);
});

function removalPool(
  options: {
    principal?: boolean;
    workspace?: boolean;
    deleted?: boolean;
    current?: boolean;
    rejectOn?: string;
    rollbackFails?: boolean;
  } = {},
) {
  const release = vi.fn();
  const query = vi.fn(async (statement: string, _params?: unknown[]) => {
    if (options.rejectOn && statement.startsWith(options.rejectOn))
      throw new Error("Simulated database failure");
    if (options.rollbackFails && statement === "ROLLBACK")
      throw new Error("Simulated rollback failure");
    if (statement.includes("FROM principals"))
      return {
        rows:
          options.principal === false
            ? []
            : [{ id: "member", expiresAt: new Date("2030-01-01") }],
      };
    if (statement.includes("FROM workspaces"))
      return { rows: options.workspace === false ? [] : [{ id: "workspace" }] };
    if (statement.startsWith("DELETE FROM assignment_attempts"))
      return { rowCount: options.deleted === false ? 0 : 1 };
    if (statement.startsWith("SELECT clock_timestamp()"))
      return { rows: [{ valid: options.current !== false }] };
    return { rows: [], rowCount: 0 };
  });
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, connect, query, release };
}

it("confirms deletion only after the owning member's transaction commits", async () => {
  const db = removalPool();
  const token = "a".repeat(64);
  expect(await attemptStore(db.pool).remove(token, "owned-attempt")).toBe(true);
  expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
    "COMMIT",
  );
  expect(db.query.mock.calls.map(([statement]) => statement)).not.toContain(
    "ROLLBACK",
  );
  expect(db.query.mock.calls[2]![1]).toEqual([hash(token)]);
  expect(db.query.mock.calls[4]![1]).toEqual(["member", "owned-attempt"]);
  expect(db.release).toHaveBeenCalledOnce();
  expect(db.release).toHaveBeenCalledWith(undefined);
});

it("keeps deletion unconfirmed while the commit acknowledgement is pending", async () => {
  const db = removalPool();
  const originalQuery = db.query.getMockImplementation()!;
  let acknowledgeCommit!: () => void;
  const commit = new Promise<void>((resolve) => {
    acknowledgeCommit = resolve;
  });
  db.query.mockImplementation(async (statement, params) => {
    if (statement === "COMMIT") await commit;
    return originalQuery(statement, params);
  });
  const completed = vi.fn();
  const operation = attemptStore(db.pool)
    .remove("owner", "attempt")
    .then(completed);
  await vi.waitFor(() =>
    expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
      "COMMIT",
    ),
  );
  expect(completed).not.toHaveBeenCalled();
  acknowledgeCommit();
  await operation;
  expect(completed).toHaveBeenCalledWith(true);
});

it.each([
  ["revoked or missing member", { principal: false }],
  ["unavailable workspace", { workspace: false }],
  ["foreign or missing attempt", { deleted: false }],
  ["expired session after the row wait", { current: false }],
] as const)("does not delete an attempt for %s", async (_reason, options) => {
  const db = removalPool(options);
  expect(await attemptStore(db.pool).remove("owner", "attempt")).toBe(false);
  expect(db.query.mock.calls.map(([statement]) => statement)).not.toContain(
    "COMMIT",
  );
  expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
    "ROLLBACK",
  );
  expect(db.release).toHaveBeenCalledWith(undefined);
});

it.each(["DELETE FROM assignment_attempts", "COMMIT"])(
  "does not confirm deletion after %s fails",
  async (statement) => {
    const db = removalPool({ rejectOn: statement });
    expect(await attemptStore(db.pool).remove("owner", "attempt")).toBe(false);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it("discards a connection when failed deletion cannot be rolled back", async () => {
  const db = removalPool({ deleted: false, rollbackFails: true });
  expect(await attemptStore(db.pool).remove("owner", "attempt")).toBe(false);
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});

it("fails closed when an attempt database connection is unavailable", async () => {
  const connect = vi
    .fn()
    .mockRejectedValue(new Error("Connection unavailable"));
  expect(
    await attemptStore({ connect } as unknown as Pool).remove(
      "owner",
      "attempt",
    ),
  ).toBe(false);
});
