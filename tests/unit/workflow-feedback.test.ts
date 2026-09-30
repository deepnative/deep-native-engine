import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  disabledWorkflowFeedbackStore,
  parseWorkflowFeedback,
  workflowFeedbackStore,
} from "../../src/workflow-feedback.ts";

it("accepts only bounded, nonempty invented feedback text", () => {
  expect(parseWorkflowFeedback("  A useful invented improvement.  ")).toBe(
    "A useful invented improvement.",
  );
  for (const value of ["", "  ", "x".repeat(1001), 1, null, []])
    expect(parseWorkflowFeedback(value)).toBeNull();
  expect(parseWorkflowFeedback("x".repeat(1000))).toHaveLength(1000);
});

it("rejects invalid, unknown and stale workflow versions without a database write", async () => {
  const query = vi.fn();
  const feedback = workflowFeedbackStore({ query } as unknown as Pool);
  for (const [id, version, revision] of [
    ["WF-999", 1, 0],
    ["WF-001", 0, 0],
    ["WF-001", 2, 0],
    ["WF-001", 1.5, 0],
    ["WF-001", 1, -1],
    ["WF-001", 1, 1.5],
  ] as const)
    expect(
      await feedback.save("owner", id, version, "Invented note", revision),
    ).toBe(false);
  expect(await feedback.save("owner", "WF-001", 1, " ", 0)).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it("keeps disabled feedback unavailable without implying persistence", async () => {
  const feedback = disabledWorkflowFeedbackStore();
  expect(await feedback.list("owner")).toEqual([]);
  expect(await feedback.save("owner", "WF-001", 1, "Invented note", 0)).toBe(
    false,
  );
  expect(await feedback.withdraw("owner", "WF-001", 1, 1)).toBe(false);
});

it("lists only returned feedback rows", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  expect(
    await workflowFeedbackStore({ query } as unknown as Pool).list("owner"),
  ).toEqual([]);
});

it.each([0, 1])(
  "saves revision %i only after current authorization and commits the write",
  async (revision) => {
    const db = withdrawalPool();
    expect(
      await workflowFeedbackStore(db.pool).save(
        "owner",
        "WF-001",
        1,
        " Invented ",
        revision,
      ),
    ).toBe(true);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it.each([
  ["unavailable member", { principal: false }],
  ["deleting workspace", { workspace: false }],
  ["stale revision or replay", { saved: false }],
  ["expiry after write", { current: false }],
] as const)("rolls back feedback save for %s", async (_reason, options) => {
  const db = withdrawalPool(options);
  expect(
    await workflowFeedbackStore(db.pool).save(
      "owner",
      "WF-001",
      1,
      "Invented",
      1,
    ),
  ).toBe(false);
  expect(db.query.mock.calls.map(([sql]) => sql)).not.toContain("COMMIT");
  expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(db.release).toHaveBeenCalledWith(undefined);
});

it.each([
  "INSERT INTO workflow_feedback",
  "UPDATE workflow_feedback",
  "COMMIT",
])(
  "reports feedback save %s failure without claiming confirmed success",
  async (statement) => {
    const db = withdrawalPool({ rejectOn: statement });
    expect(
      await workflowFeedbackStore(db.pool).save(
        "owner",
        "WF-001",
        1,
        "Invented",
        statement.startsWith("INSERT") ? 0 : 1,
      ),
    ).toBe(statement === "COMMIT" ? "uncertain" : false);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it("discards a feedback save connection when rollback fails", async () => {
  const db = withdrawalPool({ saved: false, rollbackFails: true });
  expect(
    await workflowFeedbackStore(db.pool).save(
      "owner",
      "WF-001",
      1,
      "Invented",
      0,
    ),
  ).toBe(false);
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});

it("denies a save when the database cannot connect", async () => {
  const connect = vi.fn().mockRejectedValue(new Error("Unavailable"));
  expect(
    await workflowFeedbackStore({ connect } as unknown as Pool).save(
      "owner",
      "WF-001",
      1,
      "Invented",
      0,
    ),
  ).toBe(false);
});

function withdrawalPool(
  options: {
    principal?: boolean;
    workspace?: boolean;
    deleted?: boolean;
    saved?: boolean;
    current?: boolean;
    rejectOn?: string;
    rollbackFails?: boolean;
  } = {},
) {
  const release = vi.fn();
  const query = vi.fn(async (statement: string) => {
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
    if (
      statement.startsWith("INSERT INTO workflow_feedback") ||
      statement.startsWith("UPDATE workflow_feedback")
    )
      return { rowCount: options.saved === false ? 0 : 1 };
    if (statement.startsWith("DELETE FROM workflow_feedback"))
      return { rowCount: options.deleted === false ? 0 : 1 };
    if (statement.startsWith("SELECT clock_timestamp()"))
      return { rows: [{ valid: options.current !== false }] };
    return { rows: [], rowCount: 0 };
  });
  const connect = vi.fn(async () => ({ query, release }));
  return {
    pool: { connect } as unknown as Pool,
    connect,
    query,
    release,
  };
}

it("withdraws only a current revision for an authorized member and active workspace", async () => {
  const db = withdrawalPool();
  const feedback = workflowFeedbackStore(db.pool);
  expect(await feedback.withdraw("owner", "WF-001", 1, 2)).toBe(true);
  expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
    "COMMIT",
  );
  expect(db.release).toHaveBeenCalledOnce();
  expect(db.release).toHaveBeenCalledWith(undefined);
  for (const [id, version, revision] of [
    ["invalid", 1, 1],
    ["WF-001", 0, 1],
    ["WF-001", 1.5, 1],
    ["WF-001", 1, 0],
    ["WF-001", 1, 1.5],
  ] as const)
    expect(await feedback.withdraw("owner", id, version, revision)).toBe(false);
  expect(db.connect).toHaveBeenCalledOnce();
});

it.each([
  ["revoked or missing member", { principal: false }],
  ["unavailable workspace", { workspace: false }],
  ["stale or missing revision", { deleted: false }],
  ["expired session after the row wait", { current: false }],
] as const)("does not withdraw for %s", async (_reason, options) => {
  const db = withdrawalPool(options);
  const feedback = workflowFeedbackStore(db.pool);
  expect(await feedback.withdraw("owner", "WF-001", 1, 2)).toBe(false);
  expect(db.query.mock.calls.map(([statement]) => statement)).not.toContain(
    "COMMIT",
  );
  expect(db.query.mock.calls.map(([statement]) => statement)).toContain(
    "ROLLBACK",
  );
  expect(db.release).toHaveBeenCalledWith(undefined);
});

it.each(["DELETE FROM workflow_feedback", "COMMIT"])(
  "fails closed and releases its transaction on %s failure",
  async (statement) => {
    const db = withdrawalPool({ rejectOn: statement });
    expect(
      await workflowFeedbackStore(db.pool).withdraw("owner", "WF-001", 1, 2),
    ).toBe(false);
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(undefined);
  },
);

it("disposes a connection whose failed withdrawal cannot be rolled back", async () => {
  const db = withdrawalPool({ deleted: false, rollbackFails: true });
  expect(
    await workflowFeedbackStore(db.pool).withdraw("owner", "WF-001", 1, 2),
  ).toBe(false);
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});

it("fails closed when the feedback database connection is unavailable", async () => {
  const connect = vi
    .fn()
    .mockRejectedValue(new Error("Connection unavailable"));
  expect(
    await workflowFeedbackStore({ connect } as unknown as Pool).withdraw(
      "owner",
      "WF-001",
      1,
      2,
    ),
  ).toBe(false);
});
