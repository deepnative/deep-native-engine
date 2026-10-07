import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkflowReviewContext } from "../../src/workflow-review-transaction.ts";
const f = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  workspace: vi.fn(),
  bundle: vi.fn(),
}));
vi.mock("../../src/workflow-review-transaction.ts", async (original) => ({
  ...(await original<
    typeof import("../../src/workflow-review-transaction.ts")
  >()),
  reviewExecute: f.execute,
  reviewActors: f.actors,
  reviewWorkspace: f.workspace,
}));
vi.mock("../../src/workflow-registry.ts", () => ({ workflowBundle: f.bundle }));
import { workflowReviewStore } from "../../src/workflow-review.ts";
import { workflowReviewCheck } from "../../src/workflow-review-check.ts";
import { workflowReviewCursor } from "../../src/workflow-review-cursor.ts";
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
const secret = "invented-member-domain-secret",
  token = "a".repeat(64);
const actorId = "11111111-1111-4111-8111-111111111111",
  instanceId = "22222222-2222-4222-8222-222222222222",
  requestId = "33333333-3333-4333-8333-333333333333",
  operationId = "44444444-4444-4444-8444-444444444444";
const expires = new Date("2026-10-07T10:00:00.000Z"),
  created = new Date("2026-10-07T09:00:00.000Z");
const source = {
  instanceId,
  revision: 1,
  note: "Invented private note",
  workflowVersion: 1,
};
const row = {
  id: requestId,
  instanceId,
  workflowId: "WF-001",
  workflowVersion: 1,
  revision: 1,
  expiresAt: expires,
  createdAt: created,
  withdrawnAt: null as Date | null,
};
const checked = {
  memberId: actorId,
  instanceId,
  workflowId: "WF-001",
  workflowVersion: 1,
  revision: 1,
  expiresAt: expires.toISOString(),
};
const input = () => ({
  checked: workflowReviewCheck(secret).sign(checked),
  operationId,
  confirm: "yes",
});
const port = () =>
  workflowReviewStore({} as Pool, { enabled: true, mode: "test" }, secret);
function transaction(
  results: ({ rows: unknown[]; rowCount?: number } | unknown[])[],
) {
  const query = vi.fn().mockImplementation(async () => {
    const next = results.shift();
    if (!next) throw Error("Unexpected fixture query");
    return Array.isArray(next) ? { rows: next, rowCount: next.length } : next;
  });
  const ctx = {
    actorId,
    credentialHash: "hashed-credential",
    expires: [expires],
    tx: {
      query,
      bounded: async <T>(use: () => Promise<T>) => use(),
      observe: vi.fn().mockResolvedValue(undefined),
      deadline: () => performance.now() + 60000,
    },
  } as unknown as WorkflowReviewContext;
  f.execute.mockImplementation(async (_pool, _token, _writing, use) => {
    try {
      return { ...(await use(ctx)), deadline: performance.now() + 60000 };
    } catch (error) {
      if (error instanceof SampleFeedbackFailure) return { kind: error.kind };
      throw error;
    }
  });
  return { ctx, query };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.bundle.mockResolvedValue({ version: 1, title: "Invented workflow" });
  f.workspace.mockResolvedValue("owned-workspace");
});
it.each([false, true])(
  "WFREV-08 live mode denies all member operations even enabled=%s",
  async (enabled) => {
    const p = workflowReviewStore(
      {} as Pool,
      { enabled, mode: "live" },
      secret,
    );
    for (const call of [
      () => p.receipt(token, requestId),
      () => p.history(token),
      () => p.preview(token, "WF-001"),
      () => p.request(token, input()),
      () => p.inspect(token, operationId),
      () => p.withdraw(token, requestId, operationId, "yes"),
    ])
      expect(await call()).toEqual({ kind: "unavailable" });
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it("WFREV-08 paused creation denies only new preview/request without acquiring authority", async () => {
  const p = workflowReviewStore(
    {} as Pool,
    { enabled: false, mode: "test" },
    secret,
  );
  expect(await p.preview(token, "WF-001")).toEqual({ kind: "unavailable" });
  expect(await p.request(token, input())).toEqual({ kind: "unavailable" });
  expect(f.execute).not.toHaveBeenCalled();
});
it("WFREV-01 preview binds exact source and database-fixed expiry without granting intent", async () => {
  const t = transaction([[source], [{ expires }]]);
  const result = await port().preview(token, "WF-001");
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Preview required");
  expect(result.preview.note).toBe(source.note);
  expect(workflowReviewCheck(secret).read(result.preview.checked)).toEqual(
    checked,
  );
  expect(t.ctx.tx.observe).toHaveBeenCalledWith([expires, expires]);
  expect(t.query).toHaveBeenCalledTimes(2);
});
it.each(["missing-bundle", "missing-source", "stale-version"])(
  "WFREV-01 preview %s denies private source",
  async (defect) => {
    if (defect === "missing-bundle") f.bundle.mockResolvedValue(null);
    transaction([
      defect === "missing-source" ? [] : [{ ...source, workflowVersion: 2 }],
    ]);
    expect(await port().preview(token, "WF-001")).toEqual({ kind: "denied" });
  },
);
it("WFREV-01 malformed workflow ID denies before authority acquisition", async () => {
  expect(await port().preview(token, "unknown")).toEqual({ kind: "invalid" });
  expect(f.execute).not.toHaveBeenCalled();
});
it.each([
  null,
  7,
  [],
  {},
  { ...input(), extra: "unknown" },
  { ...input(), checked: "forged" },
  { ...input(), operationId: "not-key" },
  { ...input(), confirm: "no" },
])("WFREV-01 invalid request %j never writes", async (value) => {
  expect(await port().request(token, value)).toEqual({ kind: "invalid" });
  expect(f.execute).not.toHaveBeenCalled();
});
it("WFREV-01 checked preview for another owner denies before reading source", async () => {
  transaction([]);
  expect(
    await port().request(token, {
      ...input(),
      checked: workflowReviewCheck(secret).sign({
        ...checked,
        memberId: instanceId,
      }),
    }),
  ).toEqual({ kind: "denied" });
});
it.each(["actor", "kind", "instruction"])(
  "WFREV-06 request original key with changed %s conflicts",
  async (changed) => {
    const op = {
      actorId,
      kind: "request",
      instruction: checked,
      receiptId: requestId,
      ...(changed === "actor"
        ? { actorId: instanceId }
        : changed === "kind"
          ? { kind: "withdraw" }
          : { instruction: { ...checked, revision: 2 } }),
    };
    transaction([[source], [op]]);
    expect(await port().request(token, input())).toMatchObject({
      kind: "conflict",
    });
  },
);
it("WFREV-06 exact replay preserves original receipt and does not create another intent", async () => {
  const t = transaction([
    [source],
    [{ actorId, kind: "request", instruction: checked, receiptId: requestId }],
    [row],
    [{ expired: false, assigned: false }],
  ]);
  expect(await port().request(token, input())).toMatchObject({
    kind: "replayed",
    receipt: { requestId, state: "pending" },
  });
  expect(t.query).toHaveBeenCalledTimes(4);
});
it("WFREV-06 replay of an erased receipt denies", async () => {
  transaction([
    [source],
    [{ actorId, kind: "request", instruction: checked, receiptId: requestId }],
    [],
  ]);
  expect(await port().request(token, input())).toEqual({ kind: "denied" });
});
it.each([
  "missing",
  "recreated",
  "revision",
  "source-version",
  "bundle-version",
])("WFREV-04 fresh request for %s source denies", async (defect) => {
  if (defect === "bundle-version") f.bundle.mockResolvedValue({ version: 2 });
  const current =
    defect === "missing"
      ? []
      : [
          {
            ...source,
            ...(defect === "recreated"
              ? { instanceId: requestId }
              : defect === "revision"
                ? { revision: 2 }
                : defect === "source-version"
                  ? { workflowVersion: 2 }
                  : {}),
          },
        ];
  transaction([current, []]);
  expect(await port().request(token, input())).toEqual({ kind: "denied" });
});
it("WFREV-06 another active intent for same exact source conflicts", async () => {
  transaction([[source], [], [{ id: requestId }]]);
  expect(await port().request(token, input())).toMatchObject({
    kind: "conflict",
  });
});
it("WFREV-06 original key already globally reserved conflicts without inserting intent", async () => {
  transaction([[source], [], [], { rows: [], rowCount: 0 }]);
  expect(await port().request(token, input())).toMatchObject({
    kind: "conflict",
  });
});
it("WFREV-01 deliberate current exact request creates canonical finite receipt", async () => {
  const t = transaction([
    [source],
    [],
    [],
    { rows: [{ operation_id: operationId }], rowCount: 1 },
    [],
    [row],
    [{ expired: false, assigned: false }],
  ]);
  expect(await port().request(token, input())).toMatchObject({
    kind: "applied",
    receipt: { requestId, state: "pending", expiresAt: checked.expiresAt },
  });
  const values = t.query.mock.calls[3]![1] as unknown[];
  expect(values).toContain(JSON.stringify(checked));
  expect(values).not.toContain(source.note);
});
it.each([
  {
    name: "withdrawn",
    saved: { ...row, withdrawnAt: created },
    current: source,
    status: { expired: false, assigned: true },
    bundle: { version: 1 },
  },
  {
    name: "expired",
    saved: row,
    current: source,
    status: { expired: true, assigned: true },
    bundle: { version: 1 },
  },
  {
    name: "unavailable",
    saved: row,
    current: source,
    status: { expired: false, assigned: true },
    bundle: null,
  },
  {
    name: "unavailable",
    saved: row,
    current: source,
    status: { expired: false, assigned: true },
    bundle: { version: 2 },
  },
  {
    name: "superseded",
    saved: row,
    current: undefined,
    status: { expired: false, assigned: true },
    bundle: { version: 1 },
  },
  {
    name: "superseded",
    saved: row,
    current: { ...source, instanceId: requestId },
    status: { expired: false, assigned: true },
    bundle: { version: 1 },
  },
  {
    name: "superseded",
    saved: row,
    current: { ...source, revision: 2 },
    status: { expired: false, assigned: true },
    bundle: { version: 1 },
  },
  {
    name: "assigned",
    saved: row,
    current: source,
    status: { expired: false, assigned: true },
    bundle: { version: 1 },
  },
  {
    name: "pending",
    saved: row,
    current: source,
    status: { expired: false, assigned: false },
    bundle: { version: 1 },
  },
])(
  "WFREV-04/07 canonical metadata receipt projects $name truthfully without a note",
  async ({ name, saved, current, status, bundle }) => {
    f.bundle.mockResolvedValue(bundle);
    transaction([
      [{ workflowId: "WF-001", workflowVersion: 1 }],
      current ? [current] : [],
      [saved],
      [status],
    ]);
    const result = await port().receipt(token, requestId);
    expect(result).toMatchObject({
      kind: "ready",
      receipt: { state: name, requestId },
    });
    expect(JSON.stringify(result)).not.toContain(source.note);
  },
);
it.each(["discovery", "locked-receipt"])(
  "WFREV-07 missing %s canonical receipt denies",
  async (boundary) => {
    transaction(
      boundary === "discovery"
        ? [[]]
        : [[{ workflowId: "WF-001", workflowVersion: 1 }], [source], []],
    );
    expect(await port().receipt(token, requestId)).toEqual({ kind: "denied" });
  },
);
it("WFREV-07 invalid receipt and operation identifiers never acquire authority", async () => {
  expect(await port().receipt(token, "invalid")).toEqual({ kind: "invalid" });
  expect(await port().inspect(token, "invalid")).toEqual({ kind: "invalid" });
  expect(f.execute).not.toHaveBeenCalled();
});
it("WFREV-06 unknown original key is empty inspection rather than a noncommit promise", async () => {
  transaction([[]]);
  expect(await port().inspect(token, operationId)).toMatchObject({
    kind: "ready",
    receipt: null,
  });
});
it.each([
  { actorId: instanceId, kind: "request", receiptId: requestId },
  { actorId, kind: "request", receiptId: null },
  { actorId, kind: "assign", receiptId: requestId },
])(
  "WFREV-06 foreign or tombstoned operation %j denies inspection",
  async (op) => {
    transaction([[op]]);
    expect(await port().inspect(token, operationId)).toEqual({
      kind: "denied",
    });
  },
);
it.each(["discovery", "locked-receipt"])(
  "WFREV-06 operation with missing %s denies inspection",
  async (boundary) => {
    const op = { actorId, kind: "request", receiptId: requestId };
    transaction(
      boundary === "discovery"
        ? [[op], []]
        : [[op], [{ workflowId: "WF-001", workflowVersion: 1 }], [source], []],
    );
    expect(await port().inspect(token, operationId)).toEqual({
      kind: "denied",
    });
  },
);
it("WFREV-06 original withdrawal inspection returns retained metadata without redispatch", async () => {
  transaction([
    [{ actorId, kind: "withdraw", receiptId: requestId }],
    [{ workflowId: "WF-001", workflowVersion: 1 }],
    [source],
    [{ ...row, withdrawnAt: created }],
    [{ expired: false, assigned: false }],
  ]);
  expect(await port().inspect(token, operationId)).toMatchObject({
    kind: "ready",
    receipt: { state: "withdrawn" },
  });
});
it.each([
  { requestId: "invalid", key: operationId, confirm: "yes" },
  { requestId, key: "invalid", confirm: "yes" },
  { requestId, key: operationId, confirm: "no" },
])("WFREV-04 invalid withdrawal %j never acquires authority", async (value) => {
  expect(
    await port().withdraw(token, value.requestId, value.key, value.confirm),
  ).toEqual({ kind: "invalid" });
  expect(f.execute).not.toHaveBeenCalled();
});
it.each(["actor", "kind", "instruction"])(
  "WFREV-06 withdrawal key with changed %s conflicts",
  async (changed) => {
    const op = {
      actorId,
      kind: "withdraw",
      instruction: { requestId },
      receiptId: requestId,
      ...(changed === "actor"
        ? { actorId: instanceId }
        : changed === "kind"
          ? { kind: "request" }
          : { instruction: { requestId: instanceId } }),
    };
    transaction([
      [{ workflowId: "WF-001", workflowVersion: 1 }],
      [source],
      [row],
      [op],
    ]);
    expect(
      await port().withdraw(token, requestId, operationId, "yes"),
    ).toMatchObject({ kind: "conflict" });
  },
);
it.each(["discovery", "locked-receipt"])(
  "WFREV-04 missing %s denies withdrawal",
  async (boundary) => {
    transaction(
      boundary === "discovery"
        ? [[]]
        : [[{ workflowId: "WF-001", workflowVersion: 1 }], [source], []],
    );
    expect(await port().withdraw(token, requestId, operationId, "yes")).toEqual(
      { kind: "denied" },
    );
  },
);
it("WFREV-06 withdrawal key reservation conflict leaves permission unchanged", async () => {
  transaction([
    [{ workflowId: "WF-001", workflowVersion: 1 }],
    [source],
    [row],
    [],
    { rows: [], rowCount: 0 },
  ]);
  expect(
    await port().withdraw(token, requestId, operationId, "yes"),
  ).toMatchObject({ kind: "conflict" });
});
it("WFREV-04 deliberate permission withdrawal retains source and fixed original receipt", async () => {
  const t = transaction([
    [{ workflowId: "WF-001", workflowVersion: 1 }],
    [source],
    [{ ...row }],
    [],
    { rows: [{}], rowCount: 1 },
    [{ at: created }],
    [{ expired: false, assigned: true }],
  ]);
  expect(
    await port().withdraw(token, requestId, operationId, "yes"),
  ).toMatchObject({
    kind: "applied",
    receipt: { state: "withdrawn", withdrawnAt: created.toISOString() },
  });
  expect(t.query).toHaveBeenCalledTimes(7);
});
it("WFREV-06 exact withdrawal replay does not renew or repeat its durable change", async () => {
  const t = transaction([
    [{ workflowId: "WF-001", workflowVersion: 1 }],
    [source],
    [{ ...row, withdrawnAt: created }],
    [
      {
        actorId,
        kind: "withdraw",
        instruction: { requestId },
        receiptId: requestId,
      },
    ],
    [{ expired: false, assigned: false }],
  ]);
  expect(
    await port().withdraw(token, requestId, operationId, "yes"),
  ).toMatchObject({ kind: "replayed", receipt: { state: "withdrawn" } });
  expect(t.query).toHaveBeenCalledTimes(5);
});
it("WFREV-07 invalid and foreign history cursors deny", async () => {
  expect(await port().history(token, "forged")).toEqual({ kind: "invalid" });
  transaction([]);
  const cursor = workflowReviewCursor(secret, "member-history").sign({
    actorId: instanceId,
    id: requestId,
    createdAt: "2026-10-07T09:00:00.000000Z",
  });
  expect(await port().history(token, cursor)).toEqual({ kind: "denied" });
});
it("WFREV-07 empty history has no continuation or invented receipt", async () => {
  transaction([[], [], []]);
  expect(await port().history(token)).toMatchObject({
    kind: "ready",
    receipts: [],
    next: null,
  });
});
it("WFREV-07 paged metadata uses stable microsecond continuation and omits vanished locked rows", async () => {
  const codec = workflowReviewCursor(secret, "member-history"),
    position = "2026-10-07T09:00:00.123456Z";
  const discovered = Array.from({ length: 21 }, (_, n) => ({
    id:
      n === 0
        ? requestId
        : `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    workflowId: "WF-001",
    workflowVersion: 1,
    position,
  }));
  transaction([
    discovered,
    [{ ...source, workflowId: "WF-001" }],
    [row],
    [{ expired: false, assigned: false }],
  ]);
  const result = await port().history(
    token,
    codec.sign({ actorId, id: instanceId, createdAt: position }),
  );
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Owned history required");
  expect(result.receipts).toHaveLength(1);
  expect(codec.read(result.next)).toEqual({
    actorId,
    createdAt: position,
    id: discovered[19]!.id,
  });
  expect(JSON.stringify(result.receipts)).not.toContain(source.note);
});
it("WFREV-07 source mismatch in retained history projects superseded instead of private text", async () => {
  transaction([
    [
      {
        id: requestId,
        workflowId: "WF-001",
        workflowVersion: 1,
        position: "2026-10-07T09:00:00.000000Z",
      },
    ],
    [{ ...source, workflowId: "WF-001", workflowVersion: 2 }],
    [row],
    [{ expired: false, assigned: false }],
  ]);
  expect(await port().history(token)).toMatchObject({
    kind: "ready",
    receipts: [{ state: "superseded" }],
  });
});
