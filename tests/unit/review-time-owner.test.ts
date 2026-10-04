import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { reviewTimeStore } from "../../src/review-time-store.ts";
import { allocateReviewTime, cancelReviewTime } from "../../src/review-time.ts";
vi.mock("../../src/review-time.ts", async (original) => ({
  ...(await original<typeof import("../../src/review-time.ts")>()),
  allocateReviewTime: vi.fn(),
  cancelReviewTime: vi.fn(),
}));
const id = "11111111-1111-4111-8111-111111111111",
  token = "a".repeat(64);
function fixture() {
  const expiry = new Date(Date.now() + 60000);
  const state = {
    member: true,
    workspace: true,
    allocation: true,
    evidence: true,
    submission: "queued" as string | null,
    expired: false,
    fail: false,
    ids: [] as string[],
  };
  const receipt = {
    allocationId: id,
    state: "allocated" as const,
    held: 20,
    consumed: 0,
    released: 0,
    ceiling: 20,
    reviewMinutes: 0,
    preparationMinutes: 0,
    sourceAvailable: true,
  };
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (state.fail) throw Error("private diagnostic");
    let rows: unknown[] = [];
    if (sql.includes("WITH instant"))
      rows = [
        { remaining: "60000", valid: !state.expired, observed: new Date() },
      ];
    else if (sql.includes("FROM principals WHERE"))
      rows = state.member ? [{ id, expires: expiry }] : [];
    else if (sql.includes("FROM workspaces WHERE"))
      rows = state.workspace ? [{ id }] : [];
    else if (sql.includes('source_key AS "sourceKey"'))
      rows = state.allocation ? [{ sourceKey: id }] : [];
    else if (sql.includes("COALESCE(e.review_minutes")) rows = [receipt];
    else if (sql.includes("ORDER BY id LIMIT 21"))
      rows = state.ids.map((id) => ({ id }));
    else if (sql.includes("FROM evidence_objects WHERE"))
      rows = state.evidence ? [{ revision: 1 }] : [];
    else if (sql.includes("FROM evidence_review_submissions WHERE"))
      rows = state.submission ? [{ id, status: state.submission }] : [];
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn().mockResolvedValue({ query, release }),
  } as unknown as Pool;
  return {
    state,
    receipt,
    statements,
    release,
    owned: reviewTimeStore(pool, { enabled: true, mode: "test" }),
    paused: reviewTimeStore(pool, { enabled: false, mode: "test" }),
  };
}
it.each(["member", "workspace", "allocation"] as const)(
  "withholds private receipt without current %s ownership",
  async (boundary) => {
    const f = fixture();
    f.state[boundary] = false;
    expect(await f.owned.receipt(token, id)).toEqual({ kind: "denied" });
    expect(f.statements).not.toContain("COMMIT");
    expect(f.release).toHaveBeenCalledTimes(1);
  },
);
it("returns a minimal owned receipt only after authorization and commit", async () => {
  const f = fixture();
  expect(await f.owned.receipt(token, id)).toEqual({
    kind: "applied",
    receipt: f.receipt,
  });
  expect(f.statements.at(-1)).toBe("COMMIT");
});
it.each([false, true])(
  "withholds a receipt when authority expires or the database fails (driver failure=%s)",
  async (driver) => {
    const f = fixture();
    if (driver) f.state.fail = true;
    else f.state.expired = true;
    expect((await f.owned.receipt(token, id)).kind).toBe(
      driver ? "unavailable" : "denied",
    );
    expect(f.statements).not.toContain("COMMIT");
  },
);
it("bounds history to twenty receipts and returns a continuation from the last emitted record", async () => {
  const f = fixture();
  f.state.ids = Array.from({ length: 21 }, (_, i) => `${i}`);
  const result = await f.owned.history(token);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected history");
  expect(result.receipts).toHaveLength(20);
  expect(result.next).toBe("19");
  expect(
    f.statements.filter((sql) => sql.includes("COALESCE(e.review_minutes")),
  ).toHaveLength(20);
});
it("returns an empty completed page and verifies a supplied cursor is owned", async () => {
  const f = fixture();
  expect(await f.owned.history(token, id)).toEqual({
    kind: "ready",
    receipts: [],
    next: null,
  });
  f.state.allocation = false;
  expect(await f.owned.history(token, id)).toEqual({ kind: "denied" });
});
it.each(["missing-source", "missing-submission", "reviewed"])(
  "does not allocate against %s",
  async (mode) => {
    const f = fixture();
    if (mode === "missing-source") f.state.evidence = false;
    else f.state.submission = mode === "reviewed" ? "reviewed" : null;
    expect(await f.owned.allocate(token, id, id, 20)).toEqual({
      kind: "denied",
    });
    expect(
      f.statements.some((sql) =>
        sql.includes("INSERT INTO review_time_allocations"),
      ),
    ).toBe(false);
  },
);

it("allocates only after current owner, safe source and queued submission checks, preserving the original operation", async () => {
  const f = fixture();
  const allocate = vi.mocked(allocateReviewTime);
  allocate
    .mockClear()
    .mockResolvedValue({ kind: "applied", receipt: f.receipt });
  expect(await f.owned.allocate(token, id, id, 20)).toMatchObject({
    kind: "applied",
    receipt: { held: 20 },
  });
  expect(allocate).toHaveBeenCalledOnce();
  expect(allocate.mock.calls[0]!.slice(1, 4)).toEqual([
    {
      sourceKey: id,
      workspaceId: id,
      evidenceId: id,
      sourceRevision: 1,
      memberId: id,
      withdrawnAt: null,
      resolvedAt: null,
    },
    id,
    20,
  ]);
  expect(f.statements.at(-1)).toBe("COMMIT");
  f.state.member = false;
  expect(await f.owned.allocate(token, id, id, 20)).toEqual({ kind: "denied" });
  expect(allocate).toHaveBeenCalledOnce();
});
it("permits paused owner cancellation while refusing an unavailable allocation before settlement", async () => {
  const f = fixture(),
    cancel = vi.mocked(cancelReviewTime);
  cancel.mockClear().mockResolvedValue({
    kind: "applied",
    receipt: {
      ...f.receipt,
      state: "cancelled",
      held: 0,
      released: 20,
    },
  });
  expect(await f.paused.cancel(token, id)).toMatchObject({
    kind: "applied",
    receipt: { state: "cancelled", held: 0, released: 20 },
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(
    f.statements.some(
      (sql) =>
        sql.includes('source_key AS "sourceKey"') && sql.endsWith("FOR UPDATE"),
    ),
  ).toBe(true);
  expect(f.statements.at(-1)).toBe("COMMIT");
  f.state.allocation = false;
  expect(await f.paused.cancel(token, id)).toEqual({ kind: "denied" });
  expect(cancel).toHaveBeenCalledOnce();
});
