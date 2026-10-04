import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { reviewerWorklistStore } from "../../src/reviewer-worklist.ts";
import {
  reviewerWorklistCursor,
  type ReviewerWorklistView,
} from "../../src/reviewer-worklist-cursor.ts";
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
const tx = vi.hoisted(() => ({
  query: vi.fn(),
  observe: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../../src/sample-feedback-lifetime.ts", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/sample-feedback-lifetime.ts")
    >();
  return { ...original, sampleFeedbackTransaction: tx.run };
});
const token = "a".repeat(64),
  secret = Buffer.alloc(32, 3),
  pool = {} as Pool;
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
function item(n = 1) {
  return {
    id: id(n),
    evidenceId: id(n + 100),
    workspaceId: id(200),
    assignmentId: id(201),
    grantId: id(n + 300),
    title: "Invented title",
    version: 2,
    at: "2026-01-01T12:00:00.123456Z",
    state: "draft",
    assignmentExpires: new Date(Date.now() + 3600000),
    grantExpires: new Date(Date.now() + 3600000),
  };
}
function fixture(count = 1) {
  const state = {
    actor: true,
    role: true,
    rows: Array.from({ length: count }, (_, i) => item(i + 1)),
    missingLock: "",
    current: undefined as ReturnType<typeof item>[] | undefined,
  };
  tx.query.mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes("FROM principals"))
      return {
        rows: state.actor
          ? [{ id: id(500), expires: new Date(Date.now() + 3600000) }]
          : [],
      };
    if (sql.includes("FROM staff_profiles"))
      return { rows: state.role ? [{ principal_id: id(500) }] : [] };
    if (sql.startsWith("SELECT s.id"))
      return {
        rows: sql.includes("AND s.id=ANY")
          ? (state.current ?? state.rows)
          : state.rows,
      };
    if (sql.startsWith("SELECT id FROM private_sample_feedback"))
      return { rows: [] };
    if (sql.startsWith("SELECT id FROM"))
      return {
        rows:
          sql.includes(state.missingLock) && state.missingLock
            ? []
            : (values[0] as string[]).map((id) => ({ id })),
      };
    if (sql === "SELECT clock_timestamp() AS at")
      return { rows: [{ at: new Date("2026-10-04T12:00:00Z") }] };
    if (sql.startsWith("INSERT INTO private_sample_feedback_audit"))
      return { rows: [] };
    throw Error("Unrecognized database test operation");
  });
  return state;
}
beforeEach(() => {
  vi.resetAllMocks();
  tx.run.mockImplementation(async (_pool, _writing, use) => use(tx));
  tx.observe.mockResolvedValue(undefined);
});
it("returns only permitted metadata and fences the page through the transaction", async () => {
  fixture();
  const result = await reviewerWorklistStore(pool).list(token, "active");
  expect(result).toMatchObject({
    kind: "ready",
    view: "active",
    next: null,
    items: [{ title: "Invented title", version: 2, state: "draft" }],
  });
  if (result.kind !== "ready") throw Error("Expected result");
  expect(Object.keys(result.items[0]!).sort()).toEqual([
    "ageMinutes",
    "evidenceId",
    "state",
    "submittedAt",
    "title",
    "version",
  ]);
  expect(tx.run).toHaveBeenCalledOnce();
  expect(tx.run.mock.calls[0]?.[1]).toBe(false);
  expect(tx.observe).toHaveBeenCalledTimes(3);
  const audits = tx.query.mock.calls.filter(([sql]) =>
    sql.startsWith("INSERT"),
  );
  expect(audits).toHaveLength(1);
  expect(JSON.stringify(audits)).not.toContain("Invented title");
});
it("uses a lookahead with session/view-bound fixed-lifetime continuation", async () => {
  fixture(21);
  const store = reviewerWorklistStore(pool, secret);
  const first = await store.list(token, "completed");
  if (first.kind !== "ready" || !first.next)
    throw Error("Expected continued result");
  expect(first.items).toHaveLength(20);
  const decoded = reviewerWorklistCursor(secret).decode(
    token,
    "completed",
    first.next,
  );
  if (!decoded || decoded === "invalid") throw Error("Expected cursor");
  expect(decoded.id).toBe(id(20));
  const second = await store.list(token, "completed", first.next);
  if (second.kind !== "ready" || !second.next) throw Error("Expected result");
  expect(
    reviewerWorklistCursor(secret).decode(token, "completed", second.next),
  ).toMatchObject({ expires: decoded.expires });
  expect(
    tx.query.mock.calls.some(
      ([sql, values]) =>
        sql.includes("$4::timestamptz") &&
        values[3] === decoded.at &&
        values[4] === decoded.id,
    ),
  ).toBe(true);
});
it("returns a fenced empty page without source or audit reads", async () => {
  fixture(0);
  expect(await reviewerWorklistStore(pool).list(token, "active")).toEqual({
    kind: "ready",
    view: "active",
    items: [],
    next: null,
  });
  expect(tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
  expect(tx.observe).toHaveBeenCalledTimes(3);
});
it("rejects invalid request boundaries before starting a transaction", async () => {
  expect(
    await reviewerWorklistStore(pool, secret, false).list(token, "active"),
  ).toEqual({ kind: "unavailable" });
  const store = reviewerWorklistStore(pool, secret);
  expect(await store.list("bad", "active")).toEqual({ kind: "denied" });
  expect(await store.list(token, "unknown" as ReviewerWorklistView)).toEqual({
    kind: "invalid",
  });
  expect(await store.list(token, "active", "broken")).toEqual({
    kind: "invalid",
  });
  expect(tx.run).not.toHaveBeenCalled();
});
it.each(["actor", "role"] as const)(
  "denies missing current %s without emitting rows",
  async (key) => {
    const f = fixture();
    f[key] = false;
    expect(await reviewerWorklistStore(pool).list(token, "active")).toEqual({
      kind: "denied",
    });
    expect(tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  },
);
it.each([
  "workspaces",
  "evidence_objects",
  "evidence_review_submissions",
  "assignment_grants",
  "reviewer_evidence_grants",
])("withholds the whole page after losing %s", async (table) => {
  const f = fixture();
  f.missingLock = `FROM ${table} `;
  expect(await reviewerWorklistStore(pool).list(token, "active")).toEqual({
    kind: "denied",
  });
  expect(tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it.each([
  "id",
  "evidenceId",
  "workspaceId",
  "assignmentId",
  "grantId",
  "missing",
])("does not silently substitute changed %s authority", async (key) => {
  const f = fixture();
  f.current = key === "missing" ? [] : [{ ...f.rows[0]!, [key]: id(999) }];
  expect(await reviewerWorklistStore(pool).list(token, "active")).toEqual({
    kind: "denied",
  });
  expect(tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
it.each([
  new SampleFeedbackFailure("denied"),
  new SampleFeedbackFailure("unavailable"),
  Error("private server error"),
])("withholds a transaction failure", async (error) => {
  fixture();
  tx.run.mockRejectedValue(error);
  expect(await reviewerWorklistStore(pool).list(token, "active")).toEqual({
    kind:
      error instanceof SampleFeedbackFailure && error.kind === "denied"
        ? "denied"
        : "unavailable",
  });
});
