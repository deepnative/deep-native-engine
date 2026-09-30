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

it("reads only the hashed owner session and preserves missing results", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const attempts = attemptStore({ query } as unknown as Pool);
  const credential = "a".repeat(64);
  expect(await attempts.list(credential)).toEqual([]);
  expect(await attempts.detail(credential, "attempt-id")).toBeNull();
  expect(query.mock.calls.map((call) => call[1][0])).toEqual([
    hash(credential),
    hash(credential),
  ]);
  query.mockResolvedValueOnce({ rows: [{ id: "owned", revision: 2 }] });
  expect(await attempts.detail(credential, "owned")).toMatchObject({
    id: "owned",
    revision: 2,
  });
  query.mockResolvedValueOnce({ rows: [{ id: "owned" }] });
  expect(await attempts.list(credential)).toEqual([{ id: "owned" }]);
});

function transactionPool(
  options: {
    principal?: boolean;
    workspace?: boolean;
    deleted?: boolean;
    current?: boolean;
    mutation?: boolean;
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
    if (
      statement.startsWith("INSERT INTO assignment_attempts") ||
      statement.startsWith("UPDATE assignment_attempts") ||
      statement.startsWith("WITH submitted")
    )
      return options.mutation === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "owned" }], rowCount: 1 };
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
  const db = transactionPool();
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
  const db = transactionPool();
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
  const db = transactionPool(options);
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
    const db = transactionPool({ rejectOn: statement });
    expect(await attemptStore(db.pool).remove("owner", "attempt")).toBe(false);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it("discards a connection when failed deletion cannot be rolled back", async () => {
  const db = transactionPool({ deleted: false, rollbackFails: true });
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

const mutations = ["start", "save", "submit", "revise"] as const;
function mutate(
  store: ReturnType<typeof attemptStore>,
  operation: (typeof mutations)[number],
) {
  if (operation === "start") return store.start("owner");
  if (operation === "save")
    return store.save("owner", "attempt", 2, "An invented replacement answer.");
  if (operation === "submit") return store.submit("owner", "attempt", 2);
  return store.revise("owner", "attempt");
}

it.each(mutations)(
  "confirms %s only after its transaction commits",
  async (operation) => {
    const db = transactionPool();
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
    const pending = mutate(attemptStore(db.pool), operation).then(completed);
    await vi.waitFor(() =>
      expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
        "COMMIT",
      ),
    );
    expect(completed).not.toHaveBeenCalled();
    expect(db.query.mock.calls[2]![1]).toEqual([hash("owner")]);
    acknowledgeCommit();
    await pending;
    expect(completed).toHaveBeenCalledWith(
      operation === "start" ? "owned" : true,
    );
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it.each(mutations)(
  "does not confirm %s for denied, stale or expired state",
  async (operation) => {
    for (const options of [
      { principal: false },
      { workspace: false },
      { mutation: false },
      { current: false },
    ]) {
      const db = transactionPool(options);
      expect(await mutate(attemptStore(db.pool), operation)).toBe(
        operation === "start" ? null : false,
      );
      if (!("mutation" in options)) {
        expect(
          db.query.mock.calls.map(([statement]) => statement),
        ).not.toContain("COMMIT");
        expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
          "ROLLBACK",
        );
      }
      expect(db.release).toHaveBeenCalledWith(undefined);
    }
  },
);

it.each(["UPDATE assignment_attempts", "COMMIT"])(
  "preserves an unknown save outcome when %s fails",
  async (rejectOn) => {
    const db = transactionPool({ rejectOn });
    await expect(mutate(attemptStore(db.pool), "save")).rejects.toThrow(
      "Simulated database failure",
    );
    expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
      "ROLLBACK",
    );
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it("discards a connection when an expired mutation cannot roll back", async () => {
  const db = transactionPool({ current: false, rollbackFails: true });
  expect(await mutate(attemptStore(db.pool), "save")).toBe(false);
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});

it("keeps a connection failure as an unconfirmed write error", async () => {
  const pool = {
    connect: vi.fn().mockRejectedValue(new Error("Connection unavailable")),
  } as unknown as Pool;
  await expect(mutate(attemptStore(pool), "save")).rejects.toThrow(
    "Connection unavailable",
  );
});
