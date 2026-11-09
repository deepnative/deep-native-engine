import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
import {
  disabledLocalAiHoldDecisionStore,
  localAiHoldDecisionStore,
  validHoldTestInput,
} from "../../src/local-ai-hold-decisions.ts";
const tx = vi.hoisted(() => ({
  query: vi.fn(),
  observe: vi.fn(),
  authority: vi.fn(),
  workspaces: vi.fn(),
}));
vi.mock("../../src/sample-feedback-lifetime.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/sample-feedback-lifetime.ts")
  >()),
  sampleFeedbackTransaction: async (
    _pool: unknown,
    _writing: boolean,
    use: (t: unknown) => unknown,
  ) => use({ query: tx.query, observe: tx.observe }),
}));
vi.mock(
  "../../src/local-ai-hold-inspection-grants.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/local-ai-hold-inspection-grants.ts")
    >()),
    holdInspectionAuthority: tx.authority,
    holdInspectionWorkspaces: tx.workspaces,
  }),
);
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const token = "a".repeat(64),
  operator = id(1),
  member = id(2),
  job = id(3),
  grant = id(4),
  key = id(5);
const decidedAt = new Date("2026-11-07T15:00:00.000Z");
const input = {
  outcome: "test-executed" as const,
  reason: "matching-test-record" as const,
  sourceReference: "test-record-1",
  key,
};
const stored = (overrides: Record<string, unknown> = {}) => ({
  outcome: "test-executed",
  reason: "matching-test-record",
  sourceReference: "test-record-1",
  priorStatus: "needs_reconciliation",
  decidedAt,
  operatorId: operator,
  key,
  ...overrides,
});
let state: {
  owner: boolean;
  target: Record<string, unknown> | null;
  grant: boolean;
  current: ReturnType<typeof stored> | null;
  prior: (ReturnType<typeof stored> & { jobId: string }) | null;
  inserted: boolean;
};
beforeEach(() => {
  state = {
    owner: true,
    target: {
      status: "needs_reconciliation",
      expired: false,
      metered: false,
      unitState: null,
    },
    grant: true,
    current: null,
    prior: null,
    inserted: true,
  };
  tx.query.mockReset();
  tx.observe.mockReset();
  tx.authority.mockReset();
  tx.workspaces.mockReset();
  tx.authority.mockResolvedValue({
    actorId: operator,
    deadlines: [new Date(Date.now() + 60000)],
  });
  tx.query.mockImplementation(async (sql: string) => {
    let rows: unknown[] = [];
    if (sql.startsWith('SELECT member_id AS "memberId"'))
      rows = state.owner ? [{ memberId: member }] : [];
    else if (sql.startsWith("SELECT j.status"))
      rows = state.target ? [state.target] : [];
    else if (sql.startsWith("SELECT id,expires_at"))
      rows = state.grant
        ? [{ id: grant, expires: new Date(Date.now() + 30000) }]
        : [];
    else if (sql.startsWith('SELECT job_id AS "jobId"'))
      rows = state.prior ? [state.prior] : [];
    else if (sql.startsWith("SELECT outcome"))
      rows = state.current ? [state.current] : [];
    else if (sql.startsWith("INSERT")) rows = state.inserted ? [stored()] : [];
    return { rows, rowCount: rows.length };
  });
});
const pool = {} as Pool;
const decisions = localAiHoldDecisionStore(pool, {
  mode: "test",
  enabled: true,
});

it("validates only allowlisted outcomes, reasons, test references and keys", () => {
  expect(validHoldTestInput(input)).toBe(true);
  for (const bad of [
    { outcome: "provider-confirmed" },
    { reason: "free text" },
    { sourceReference: 7 },
    { sourceReference: "PRIVATE text" },
    { key: "nope" },
  ])
    expect(validHoldTestInput({ ...input, ...bad })).toBe(false);
});

it("is unavailable when disabled, in live mode or through the disabled port", async () => {
  for (const store of [
    localAiHoldDecisionStore(pool, { mode: "live", enabled: true }),
    localAiHoldDecisionStore(pool, { mode: "test", enabled: false }),
    disabledLocalAiHoldDecisionStore(),
  ]) {
    expect(await store.read(token, job)).toEqual({ kind: "unavailable" });
    expect(await store.record(token, job, input)).toEqual({
      kind: "unavailable",
    });
  }
  expect(tx.query).not.toHaveBeenCalled();
});

it("refuses malformed credentials and references before any query", async () => {
  expect(await decisions.read("short", job)).toEqual({ kind: "denied" });
  expect(await decisions.read(token, "nope")).toEqual({ kind: "invalid" });
  expect(await decisions.record("short", job, input)).toEqual({
    kind: "denied",
  });
  expect(await decisions.record(token, "nope", input)).toEqual({
    kind: "invalid",
  });
  expect(
    await decisions.record(token, job, { ...input, outcome: "x" as never }),
  ).toEqual({ kind: "invalid" });
  expect(tx.query).not.toHaveBeenCalled();
});

it("reads an open held request, then a recorded decision by reader or another operator", async () => {
  expect(await decisions.read(token, job)).toEqual({
    kind: "ready",
    jobId: job,
    open: true,
    metered: false,
    decision: null,
  });
  expect(tx.authority).toHaveBeenCalledWith(
    expect.anything(),
    token,
    "operator",
    [member],
  );
  state.current = stored({ priorStatus: "expired-claim" });
  expect(await decisions.read(token, job)).toMatchObject({
    open: false,
    decision: {
      sourceKind: "invented-test-record",
      priorStatus: "expired-claim",
      decidedAt: decidedAt.toISOString(),
      decidedByReader: true,
    },
  });
  state.current = stored({ operatorId: null });
  expect(await decisions.read(token, job)).toMatchObject({
    decision: { decidedByReader: false },
  });
});

it.each([
  [{ status: "running", expired: true, metered: false, unitState: null }, true],
  [
    { status: "running", expired: false, metered: false, unitState: null },
    false,
  ],
  [
    { status: "succeeded", expired: false, metered: false, unitState: null },
    false,
  ],
  [
    {
      status: "needs_reconciliation",
      expired: false,
      metered: true,
      unitState: "reserved",
    },
    true,
  ],
  [
    {
      status: "needs_reconciliation",
      expired: false,
      metered: true,
      unitState: "consumed",
    },
    false,
  ],
])("decides whether %o is open", async (target, open) => {
  state.target = target;
  expect(await decisions.read(token, job)).toMatchObject({ open });
});

it.each(["owner", "target", "grant"] as const)(
  "denies when the %s is missing",
  async (missing) => {
    if (missing === "owner") state.owner = false;
    else if (missing === "target") state.target = null;
    else state.grant = false;
    expect(await decisions.read(token, job)).toEqual({ kind: "denied" });
    expect(await decisions.record(token, job, input)).toEqual({
      kind: "denied",
    });
  },
);

it("records a decision on a held request without touching the job", async () => {
  expect(await decisions.record(token, job, input)).toMatchObject({
    kind: "applied",
    decision: { outcome: "test-executed", decidedByReader: true },
  });
  const sql = tx.query.mock.calls.map(([q]) => q as string);
  expect(sql.some((q) => q.startsWith("UPDATE adapter_jobs"))).toBe(false);
  expect(tx.query.mock.calls.at(-1)![1]).toEqual([
    job,
    member,
    grant,
    operator,
    "test-executed",
    "matching-test-record",
    "test-record-1",
    "needs_reconciliation",
    key,
  ]);
  expect(tx.observe).toHaveBeenCalled();
});

it("holds an expired claim before recording it", async () => {
  state.target = {
    status: "running",
    expired: true,
    metered: false,
    unitState: null,
  };
  expect((await decisions.record(token, job, input)).kind).toBe("applied");
  const sql = tx.query.mock.calls.map(([q]) => q as string);
  const update = sql.findIndex((q) => q.startsWith("UPDATE adapter_jobs"));
  expect(update).toBeGreaterThan(-1);
  expect(update).toBeLessThan(sql.findIndex((q) => q.startsWith("INSERT")));
  expect(tx.query.mock.calls.at(-1)![1]).toContain("expired-claim");
});

it("replays the same key and conflicts on any change, another decision or a closed request", async () => {
  state.prior = { ...stored(), jobId: job };
  expect(await decisions.record(token, job, input)).toMatchObject({
    kind: "replayed",
  });
  for (const change of [
    { jobId: id(9) },
    { outcome: "test-not-executed" },
    { reason: "operator-test-exercise" },
    { sourceReference: "test-other" },
  ]) {
    state.prior = { ...stored(), jobId: job, ...change };
    expect(await decisions.record(token, job, input)).toEqual({
      kind: "conflict",
    });
  }
  state.prior = null;
  state.current = stored();
  expect(await decisions.record(token, job, input)).toEqual({
    kind: "conflict",
  });
  state.current = null;
  state.target = {
    status: "succeeded",
    expired: false,
    metered: false,
    unitState: null,
  };
  expect(await decisions.record(token, job, input)).toEqual({
    kind: "closed",
  });
});

it("reports an unconfirmed insert or database failure as unavailable", async () => {
  state.inserted = false;
  expect(await decisions.record(token, job, input)).toEqual({
    kind: "unavailable",
  });
  tx.query.mockRejectedValue(Error("PRIVATE-DIAGNOSTIC"));
  expect(await decisions.record(token, job, input)).toEqual({
    kind: "unavailable",
  });
  expect(await decisions.read(token, job)).toEqual({ kind: "unavailable" });
  tx.query.mockRejectedValue(new SampleFeedbackFailure("denied"));
  expect(await decisions.read(token, job)).toEqual({ kind: "denied" });
});
