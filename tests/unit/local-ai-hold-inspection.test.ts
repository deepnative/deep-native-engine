import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createHmac } from "node:crypto";
import { hash } from "../../src/store.ts";
import {
  localAiHoldInspectionStore,
  disabledLocalAiHoldInspectionStore,
} from "../../src/local-ai-hold-inspection.ts";
import { HOLD_INSPECTION_PURPOSE } from "../../src/local-ai-hold-inspection-grants.ts";
import { reviewerWorklistCursor } from "../../src/reviewer-worklist-cursor.ts";
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
const tx = vi.hoisted(() => ({
  query: vi.fn(),
  observe: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../../src/sample-feedback-lifetime.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/sample-feedback-lifetime.ts")
  >()),
  sampleFeedbackTransaction: tx.run,
}));
const pool = {} as Pool,
  token = "a".repeat(64),
  secret = Buffer.alloc(32, 7);
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
function row(n = 1) {
  return {
    jobId: id(n),
    memberId: id(100),
    grantId: id(n + 200),
    grantExpires: new Date(Date.now() + 3600000),
    status: "needs_reconciliation",
    createdAt: new Date("2026-01-01T12:00:00.123Z"),
    updatedAt: new Date("2026-01-01T12:00:00.123Z"),
    leaseUntil: null as Date | null,
    at: "2026-01-01T12:00:00.123456Z",
    expiredClaim: false,
    unitState: "reserved",
    quantity: 1,
    attemptCount: 1,
    maxAttempts: 1,
    policy: "deterministic-request-test-v1",
    promptTemplateVersion: "local-simulation-v1",
    modelContractVersion: "deterministic-local-v1",
  };
}
function fixture(count = 1) {
  const state = {
    actor: true,
    role: "operator",
    owner: true,
    workspace: true,
    missingLock: "",
    actorChanged: false,
    rows: Array.from({ length: count }, (_, i) => row(i + 1)),
    current: undefined as ReturnType<typeof row>[] | undefined,
  };
  tx.query.mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes("FROM principals") && sql.includes("token_hash AS"))
      return {
        rows: [
          ...(state.actor
            ? [
                {
                  id: id(state.actorChanged ? 501 : 500),
                  tokenHash: hash(token),
                  kind: "staff",
                  expires: new Date(Date.now() + 3600000),
                },
              ]
            : []),
          ...(state.owner ? [{ id: id(100), kind: "member" }] : []),
        ],
      };
    if (sql.includes("FROM principals"))
      return { rows: state.actor ? [{ id: id(500) }] : [] };
    if (sql.includes("FROM staff_profiles"))
      return {
        rows: [{ id: id(state.actorChanged ? 501 : 500), role: state.role }],
      };
    if (sql.includes("FROM workspaces"))
      return { rows: state.workspace ? [{ memberId: id(100) }] : [] };
    if (sql.includes("WITH instant AS MATERIALIZED"))
      return {
        rows: sql.includes("AND j.id=ANY")
          ? (state.current ?? state.rows)
          : state.rows,
      };
    if (sql.startsWith("SELECT id FROM"))
      return {
        rows:
          state.missingLock && sql.includes(state.missingLock)
            ? []
            : (values[0] as string[]).map((id) => ({ id })),
      };
    throw Error("Unexpected database operation");
  });
  return state;
}
const make = () =>
  localAiHoldInspectionStore(pool, { mode: "test", enabled: true, secret });
beforeEach(() => {
  vi.resetAllMocks();
  tx.run.mockImplementation(async (_pool, _write, use) => use(tx));
  tx.observe.mockResolvedValue(undefined);
});
it("emits a fixed metadata whitelist without private or authority identities and never writes accounting", async () => {
  const f = fixture();
  Object.assign(f.rows[0]!, {
    privateText: "invented private text",
    providerError: "private provider error",
  });
  const result = await make().detail(token, id(1));
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Expected result");
  expect(Object.keys(result.value).sort()).toEqual([
    "createdAt",
    "jobId",
    "leaseUntil",
    "modelContractVersion",
    "policy",
    "promptTemplateVersion",
    "state",
    "status",
    "unitState",
    "updatedAt",
  ]);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain(id(100));
  expect(JSON.stringify(result)).not.toContain(id(201));
  expect(tx.run.mock.calls[0]?.[1]).toBe(false);
  expect(
    tx.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql)),
  ).toBe(false);
});
it.each([
  ["pending", 0, "reserved", false, null, "not-unconfirmed"],
  [
    "running",
    1,
    "reserved",
    false,
    new Date(Date.now() + 60000),
    "not-unconfirmed",
  ],
  [
    "running",
    1,
    "reserved",
    true,
    new Date(Date.now() - 60000),
    "expired-claim",
  ],
  ["succeeded", 1, "consumed", false, null, "not-unconfirmed"],
  ["exhausted", 0, "released", false, null, "not-unconfirmed"],
] as const)(
  "shows %s with its truthful unit state",
  async (status, attemptCount, unitState, expiredClaim, leaseUntil, state) => {
    const f = fixture();
    Object.assign(f.rows[0]!, {
      status,
      attemptCount,
      unitState,
      expiredClaim,
      leaseUntil,
    });
    expect(await make().detail(token, id(1))).toMatchObject({
      kind: "ready",
      value: { status, unitState, state },
    });
  },
);
it.each([
  ["jobId", "invalid"],
  ["status", "unexpected"],
  ["quantity", 2],
  ["maxAttempts", 2],
  ["attemptCount", 0],
  ["unitState", "released"],
  ["policy", "other"],
  ["promptTemplateVersion", "other"],
  ["modelContractVersion", "other"],
  ["expiredClaim", "yes"],
  ["createdAt", new Date(NaN)],
  ["updatedAt", "bad"],
  ["leaseUntil", new Date(NaN)],
])(
  "withholds malformed %s rather than disclosing a partial row",
  async (key, value) => {
    const f = fixture();
    Object.assign(f.rows[0]!, { [key as string]: value });
    expect(await make().detail(token, id(1))).toEqual({ kind: "unavailable" });
  },
);
it("withholds a running claim with no lease", async () => {
  const f = fixture();
  f.rows[0]!.status = "running";
  expect(await make().detail(token, id(1))).toEqual({ kind: "unavailable" });
});
it("rejects disabled/live and invalid boundaries without database work", async () => {
  for (const mode of ["test", "live"] as const)
    expect(
      await localAiHoldInspectionStore(pool, { mode, enabled: false }).list(
        token,
      ),
    ).toEqual({ kind: "unavailable" });
  expect(
    await localAiHoldInspectionStore(pool, {
      mode: "live",
      enabled: true,
    }).revoke(token, id(1)),
  ).toEqual({ kind: "unavailable" });
  expect(await make().list("bad")).toEqual({ kind: "denied" });
  expect(await make().detail(token, "bad")).toEqual({ kind: "invalid" });
  expect(await make().list(token, "bad")).toEqual({ kind: "invalid" });
  expect(tx.run).not.toHaveBeenCalled();
  const disabled = disabledLocalAiHoldInspectionStore();
  expect(await disabled.list(token)).toEqual({ kind: "unavailable" });
  expect(await disabled.detail(token, id(1))).toEqual({ kind: "unavailable" });
  expect(await disabled.revoke(token, id(1))).toEqual({ kind: "unavailable" });
  expect(
    await disabled.grant(token, id(1), id(2), new Date(), new Date(), id(3)),
  ).toEqual({ kind: "unavailable" });
});
it.each(["actor", "owner", "workspace"] as const)(
  "denies missing current %s",
  async (key) => {
    const f = fixture();
    f[key] = false;
    expect(await make().list(token)).toEqual({ kind: "denied" });
  },
);
it("denies a role change or substituted actor after discovery", async () => {
  const f = fixture();
  f.role = "coach";
  expect(await make().list(token)).toEqual({ kind: "denied" });
  f.role = "operator";
  f.actorChanged = true;
  expect(await make().list(token)).toEqual({ kind: "denied" });
});
it("denies an unassigned worklist", async () => {
  fixture(0);
  expect(await make().list(token)).toEqual({ kind: "denied" });
});
it.each(["adapter_jobs", "local_ai_hold_inspection_grants"])(
  "denies losing its %s fence",
  async (table) => {
    const f = fixture();
    f.missingLock = table;
    expect(await make().list(token)).toEqual({ kind: "denied" });
  },
);
it.each(["jobId", "memberId", "grantId", "missing"])(
  "denies changed %s on the locked reread",
  async (key) => {
    const f = fixture();
    f.current = key === "missing" ? [] : [{ ...f.rows[0]!, [key]: id(999) }];
    expect(await make().list(token)).toEqual({ kind: "denied" });
  },
);
it("bounds the page and binds its continuation to this actor and inspection purpose", async () => {
  fixture(21);
  const store = make();
  const first = await store.list(token);
  if (first.kind !== "ready" || !first.next)
    throw Error("Expected continuation");
  expect(first.items).toHaveLength(20);
  const derived = createHmac("sha256", secret)
    .update(HOLD_INSPECTION_PURPOSE)
    .digest();
  const decoded = reviewerWorklistCursor(derived).decode(
    token,
    "active",
    first.next,
  );
  expect(decoded).toMatchObject({ id: id(20) });
  expect((await store.list(token, first.next)).kind).toBe("ready");
  expect(await store.list("b".repeat(64), first.next)).toEqual({
    kind: "invalid",
  });
});
it.each([
  new SampleFeedbackFailure("denied"),
  new SampleFeedbackFailure("unavailable"),
  Error("invented private failure"),
])("sanitizes transaction failure", async (error) => {
  fixture();
  tx.run.mockRejectedValue(error);
  expect(await make().list(token)).toEqual({
    kind:
      error instanceof SampleFeedbackFailure && error.kind === "denied"
        ? "denied"
        : "unavailable",
  });
});
