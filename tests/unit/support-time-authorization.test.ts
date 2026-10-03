import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
const helpers = vi.hoisted(() => ({
  allocate: vi.fn(),
  cancel: vi.fn(),
  begin: vi.fn(),
  record: vi.fn(),
  receipt: vi.fn(),
  operatorReceipt: vi.fn(),
}));
vi.mock("../../src/support-time.ts", async (original) => ({
  ...(await original<typeof import("../../src/support-time.ts")>()),
  allocateSupportTime: helpers.allocate,
  cancelSupportTime: helpers.cancel,
  beginSupportTime: helpers.begin,
  recordSupportTime: helpers.record,
  supportTimeReceipt: helpers.receipt,
  supportTimeOperatorReceipt: helpers.operatorReceipt,
}));
import { supportRequestStore } from "../../src/support-requests.ts";
import { hash } from "../../src/store.ts";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const member = id(1),
  operator = id(2),
  admin = id(3),
  requestId = id(4),
  allocationId = id(5),
  grantId = id(6),
  key = id(7);
const token = "a".repeat(64),
  date = new Date("2026-01-01"),
  future = new Date("2100-01-01"),
  secret = Buffer.alloc(32, 42);
const scope = { requestId, allocationId, grantId };
const grantInput = {
  requestId,
  allocationId,
  staffId: operator,
  role: "operator" as const,
  idempotencyKey: key,
  startsAt: date,
  expiresAt: future,
};
const segments = {
  supportStart: date,
  supportEnd: new Date(+date + 60000),
  preparationStart: null,
  preparationEnd: null,
};
const receipt = {
  allocationId,
  ceiling: 20,
  state: "allocated",
  held: 20,
  consumed: 0,
  released: 0,
  supportMinutes: 0,
  preparationMinutes: 0,
};
const candidate = {
  requestId,
  allocationId,
  grantId,
  memberId: member,
  workspaceId: member,
  staffId: operator,
  cursorAt: "2026-01-01T00:00:00.000000Z",
};
const grant = {
  ...grantInput,
  id: grantId,
  purpose: "support-time-local-v1",
  active: true,
  revokedAt: null,
  grantedBy: admin,
};
const meta = {
  requestId,
  memberId: member,
  workspaceId: member,
  withdrawnAt: null,
  resolvedAt: null,
  acknowledgedAt: null,
  receivedAt: date,
  coverageState: "unverified",
};
type Options = {
  actor?: "member" | "operator" | "admin";
  disabled?: boolean;
  override?: (sql: string, values: unknown[]) => object[] | undefined;
  existing?: object;
  latest?: boolean;
  listSize?: number;
  allocationState?: string;
  request?: object;
};
function fixture(o: Options = {}) {
  const actor =
    o.actor === "member" ? member : o.actor === "admin" ? admin : operator;
  const candidates = Array.from({ length: o.listSize ?? 1 }, (_, n) => ({
    ...candidate,
    grantId: id(30 + n),
  }));
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const replaced = o.override?.(sql, values);
    if (replaced !== undefined)
      return { rows: replaced, rowCount: replaced.length };
    let rows: object[] = [];
    if (sql.startsWith("SELECT id,kind FROM principals WHERE token_hash"))
      rows = [{ id: actor, kind: actor === member ? "member" : "staff" }];
    else if (sql.includes("FROM principals WHERE id=ANY"))
      rows = [member, operator, admin]
        .filter((p) => (values[0] as string[]).includes(p))
        .map((p) => ({
          id: p,
          kind: p === member ? "member" : "staff",
          tokenHash: hash(token),
          expiresAt: future,
          active: true,
        }));
    else if (sql.includes("FROM staff_profiles WHERE"))
      rows = [
        { id: operator, role: "operator" },
        { id: admin, role: "platform_admin" },
      ];
    else if (sql.includes("FROM workspaces\n"))
      rows = [{ id: member, memberId: member, deletingAt: null }];
    else if (sql.includes("FROM support_requests r WHERE r.id=ANY"))
      rows = [{ ...meta, ...o.request }];
    else if (
      sql.includes("FROM support_requests r JOIN support_time_allocations")
    )
      rows = [candidate];
    else if (sql.includes("FROM support_time_grants g JOIN support_requests"))
      rows = sql.includes("LIMIT 21") ? candidates : [candidate];
    else if (sql.includes("FROM support_time_grants WHERE granted_by"))
      rows = o.existing ? [o.existing] : [];
    else if (sql.includes("FROM support_time_grants WHERE id=ANY"))
      rows = (values[0] as string[]).map((g) => ({ ...grant, id: g }));
    else if (sql.includes("FROM support_time_grants WHERE id=$1"))
      rows = [grant];
    else if (sql.startsWith("SELECT state FROM support_time_allocations"))
      rows = [{ state: o.allocationState ?? "allocated" }];
    else if (sql.includes("ORDER BY created_at DESC,id DESC LIMIT 1"))
      rows = o.latest ? [{ id: allocationId }] : [];
    else if (sql.includes("bool_and(deadline")) rows = [{ valid: true }];
    else if (sql.includes("r.subject,r.body FROM support_requests"))
      rows = [{ ...meta, subject: "invented", body: "invented", ...o.request }];
    return { rows, rowCount: rows.length };
  });
  const release = vi.fn(),
    connect = vi.fn().mockResolvedValue({ query, release });
  const use = supportRequestStore({ connect } as unknown as Pool, secret, {
    timeWrites: !o.disabled,
  });
  return { use, time: use.time!, query, connect, release };
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ["allocate", "cancel", "begin", "record"] as const)
    helpers[name].mockResolvedValue({ kind: "applied", receipt });
  helpers.receipt.mockResolvedValue(receipt);
  helpers.operatorReceipt.mockImplementation(
    async (_client, _actor, scope) => ({
      ...receipt,
      ...scope,
      canBegin: true,
      canRecord: false,
    }),
  );
});
it("authorizes member allocation/cancellation/read on the owned transaction and returns no receipt before allocation", async () => {
  const f = fixture({ actor: "member", latest: true });
  expect((await f.time.allocate(token, requestId, key, 20)).kind).toBe(
    "applied",
  );
  expect((await f.time.cancel(token, requestId, allocationId)).kind).toBe(
    "applied",
  );
  expect(await f.time.receipt(token, requestId)).toEqual({
    kind: "ready",
    value: receipt,
  });
  expect(
    await fixture({ actor: "member" }).time.receipt(token, requestId),
  ).toEqual({ kind: "ready", value: null });
  expect(await f.use.memberDetail(token, requestId)).toMatchObject({
    kind: "ready",
    value: { supportTime: receipt },
  });
  expect(f.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(
    4,
  );
});
it("delegates begin/record only after current exact-purpose staff scope authorization", async () => {
  const f = fixture();
  expect((await f.time.begin(token, scope, key)).kind).toBe("applied");
  expect((await f.time.record(token, scope, key, segments)).kind).toBe(
    "applied",
  );
  expect(helpers.begin).toHaveBeenCalledWith(
    expect.anything(),
    operator,
    scope,
    meta,
    key,
    expect.any(Array),
  );
  expect(helpers.record).toHaveBeenCalledWith(
    expect.anything(),
    operator,
    scope,
    key,
    segments,
    expect.any(Array),
  );
  const calls = f.query.mock.calls.map(([sql]) => sql);
  expect(
    calls.findIndex((sql) =>
      sql.startsWith("SELECT pg_advisory_xact_lock(44154"),
    ),
  ).toBeLessThan(calls.findIndex((sql) => sql.includes("FROM workspaces\n")));
});
it("keeps detail reads available during a write pause while hiding both mutation permissions", async () => {
  const f = fixture({ disabled: true });
  expect(await f.time.operatorDetail(token, scope)).toMatchObject({
    kind: "ready",
    value: { canBegin: false, canRecord: false },
  });
  expect(await fixture().time.operatorDetail(token, scope)).toMatchObject({
    kind: "ready",
    value: { canBegin: true },
  });
  for (const call of [
    () => f.time.allocate(token, requestId, key, 20),
    () => f.time.cancel(token, requestId, allocationId),
    () => f.time.begin(token, scope, key),
    () => f.time.record(token, scope, key, segments),
    () => f.time.grant(token, grantInput),
    () => f.time.revoke(token, grantId),
  ])
    expect(await call()).toEqual({ kind: "denied" });
  expect(f.connect).toHaveBeenCalledTimes(1);
});
it("rejects malformed scope, keys, ceilings and interval/grant windows before acquiring a connection", async () => {
  const f = fixture();
  for (const call of [
    () => f.time.cancel(token, "bad", allocationId),
    () => f.time.cancel(token, requestId, "bad"),
    () => f.time.operatorDetail(token, { ...scope, grantId: "bad" }),
    () =>
      f.time.record(token, { ...scope, allocationId: "bad" }, key, segments),
    () => f.time.record(token, scope, "bad", segments),
    () => f.time.record(token, scope, key, { ...segments, supportEnd: date }),
    () => f.time.begin(token, scope, "bad"),
    () => f.time.begin(token, { ...scope, requestId: "bad" }, key),
    () => f.time.allocate(token, "bad", key, 20),
    () => f.time.allocate(token, requestId, "bad", 20),
    ...[0, 121, 1.5, NaN].map(
      (n) => () => f.time.allocate(token, requestId, key, n),
    ),
    () => f.time.receipt(token, "bad"),
    () => f.time.revoke(token, "bad"),
    ...[
      { allocationId: "bad" },
      { role: "member" },
      { startsAt: "date" },
      { expiresAt: "date" },
      { startsAt: new Date(NaN) },
      { expiresAt: new Date(NaN) },
      { expiresAt: date },
    ].map(
      (change) => () =>
        f.time.grant(token, { ...grantInput, ...change } as typeof grantInput),
    ),
  ])
    expect(await call()).toEqual({ kind: "denied" });
  expect(f.connect).not.toHaveBeenCalled();
});
it.each([
  "member",
  "operator",
  "grant",
  "role",
  "purpose",
  "allocation",
  "expiry",
  "workspace",
  "request",
])(
  "denies %s authorization failure without beginning or recording effort",
  async (caseName) => {
    const f = fixture({
      actor: caseName === "member" ? "member" : "operator",
      override: (sql) => {
        if (
          caseName === "operator" &&
          sql.includes("FROM principals WHERE id=ANY")
        )
          return [
            {
              id: operator,
              kind: "staff",
              tokenHash: hash(token),
              active: true,
              expiresAt: future,
            },
          ];
        if (caseName === "role" && sql.includes("FROM staff_profiles WHERE"))
          return [{ id: operator, role: "reviewer" }];
        if (caseName === "workspace" && sql.includes("FROM workspaces\n"))
          return [{ id: member, memberId: member, deletingAt: date }];
        if (
          caseName === "request" &&
          sql.includes("FROM support_requests r WHERE r.id=ANY")
        )
          return [];
        if (
          ["grant", "purpose", "allocation"].includes(caseName) &&
          sql.includes("FROM support_time_grants WHERE id=ANY")
        )
          return caseName === "grant"
            ? []
            : [
                {
                  ...grant,
                  ...(caseName === "purpose"
                    ? { purpose: "support-request-local-v1" }
                    : { allocationId: id(99) }),
                },
              ];
        if (caseName === "expiry" && sql.includes("bool_and(deadline"))
          return [{ valid: false }];
        return undefined;
      },
    });
    expect(await f.time.begin(token, scope, key)).toEqual({ kind: "denied" });
    expect(await f.time.record(token, scope, key, segments)).toEqual({
      kind: "denied",
    });
    expect(helpers.begin).not.toHaveBeenCalled();
    expect(helpers.record).not.toHaveBeenCalled();
  },
);
it("denies expired members and wrong staff role/purpose/identity despite a discoverable grant", async () => {
  for (const change of [
    { active: false },
    { staffId: admin },
    { role: "platform_admin" },
    { requestId: id(99) },
  ]) {
    const f = fixture({
      override: (sql) =>
        sql.includes("FROM support_time_grants WHERE id=ANY")
          ? [{ ...grant, ...change }]
          : undefined,
    });
    expect(await f.time.operatorDetail(token, scope)).toEqual({
      kind: "denied",
    });
  }
  const f = fixture({
    override: (sql) =>
      sql.includes("FROM principals WHERE id=ANY")
        ? [
            {
              id: member,
              kind: "member",
              tokenHash: hash(token),
              expiresAt: future,
              active: false,
            },
            {
              id: operator,
              kind: "staff",
              tokenHash: hash(token),
              expiresAt: future,
              active: true,
            },
          ]
        : undefined,
  });
  expect(await f.time.operatorDetail(token, scope)).toEqual({ kind: "denied" });
});
it("requires a discoverable exact grant, including for a previously saved entry", async () => {
  const f = fixture({
    override: (sql) =>
      sql.includes("FROM support_time_grants g JOIN support_requests")
        ? []
        : undefined,
  });
  expect(await f.time.begin(token, scope, key)).toEqual({ kind: "denied" });
  expect(helpers.begin).not.toHaveBeenCalled();
});
it("lists at most twenty currently granted receipts and binds the signed cursor to this staff session and purpose", async () => {
  const f = fixture({ listSize: 21 }),
    result = await f.time.operatorWorklist(token);
  if (result.kind !== "ready") throw Error("Missing granted worklist");
  expect(result.value.items).toHaveLength(20);
  expect(result.value.nextCursor).toBeTruthy();
  const next = await fixture({ listSize: 0 }).time.operatorWorklist(
    token,
    result.value.nextCursor!,
  );
  expect(next).toEqual({
    kind: "ready",
    value: { items: [], nextCursor: null },
  });
  expect(
    await fixture({ listSize: 0 }).time.operatorWorklist(
      "b".repeat(64),
      result.value.nextCursor!,
    ),
  ).toEqual({ kind: "denied" });
  expect(
    await fixture().use.operatorWorklist(token, result.value.nextCursor!),
  ).toEqual({ kind: "denied" });
  expect(await fixture().time.operatorWorklist(token, "forged")).toEqual({
    kind: "denied",
  });
  expect(
    await fixture({ actor: "member" }).time.operatorWorklist(token),
  ).toEqual({ kind: "denied" });
});
it("creates a distinct exact time grant only through a current platform administrator", async () => {
  const f = fixture({ actor: "admin" });
  expect(await f.time.grant(token, grantInput)).toMatchObject({
    kind: "created",
    grantId: expect.any(String),
  });
  expect(await fixture().time.grant(token, grantInput)).toEqual({
    kind: "denied",
  });
  expect(
    await fixture({ actor: "member" }).time.grant(token, grantInput),
  ).toEqual({ kind: "denied" });
});
it("replays only the exact original unrevoked time grant and conflicts on changed scope or windows", async () => {
  expect(
    await fixture({ actor: "admin", existing: grant }).time.grant(
      token,
      grantInput,
    ),
  ).toEqual({ kind: "replayed", grantId });
  for (const change of [
    { requestId: id(99) },
    { allocationId: id(99) },
    { staffId: admin },
    { role: "platform_admin" },
    { startsAt: future },
    { expiresAt: date },
    { revokedAt: date },
  ])
    expect(
      await fixture({
        actor: "admin",
        existing: { ...grant, ...change },
      }).time.grant(token, grantInput),
    ).toEqual({ kind: "conflict" });
});
it("does not create time grants for withdrawn, resolved or already begun allocations", async () => {
  expect(
    await fixture({
      actor: "admin",
      request: { withdrawnAt: date },
    }).time.grant(token, grantInput),
  ).toEqual({ kind: "withdrawn" });
  expect(
    await fixture({ actor: "admin", request: { resolvedAt: date } }).time.grant(
      token,
      grantInput,
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    await fixture({ actor: "admin", allocationState: "begun" }).time.grant(
      token,
      grantInput,
    ),
  ).toEqual({ kind: "conflict" });
});
it("revokes time access once through current admin authorization, preserving past receipts on replay", async () => {
  expect(await fixture({ actor: "admin" }).time.revoke(token, grantId)).toEqual(
    { kind: "revoked" },
  );
  expect(
    await fixture({
      actor: "admin",
      override: (sql) =>
        sql.includes("FROM support_time_grants WHERE id=$1")
          ? [{ ...grant, revokedAt: date }]
          : undefined,
    }).time.revoke(token, grantId),
  ).toEqual({ kind: "already-revoked" });
  expect(await fixture().time.revoke(token, grantId)).toEqual({
    kind: "denied",
  });
  expect(
    await fixture({ actor: "member" }).time.revoke(token, grantId),
  ).toEqual({ kind: "denied" });
});
it("fails closed for missing or mismatched grant/revocation dependencies", async () => {
  for (const fragment of [
    "FROM support_requests r JOIN support_time_allocations",
    "SELECT state FROM support_time_allocations",
    "FROM staff_profiles WHERE",
  ]) {
    expect(
      await fixture({
        actor: "admin",
        override: (sql) => (sql.includes(fragment) ? [] : undefined),
      }).time.grant(token, grantInput),
    ).toEqual({ kind: "denied" });
  }
  for (const fragment of [
    "FROM support_time_grants g JOIN support_requests",
    "FROM support_time_grants WHERE id=$1",
    "FROM support_requests r WHERE r.id=ANY",
  ]) {
    expect(
      await fixture({
        actor: "admin",
        override: (sql) => (sql.includes(fragment) ? [] : undefined),
      }).time.revoke(token, grantId),
    ).toEqual({ kind: "denied" });
  }
  for (const change of [
    { requestId: id(99) },
    { staffId: admin },
    { allocationId: id(99) },
  ])
    expect(
      await fixture({
        actor: "admin",
        override: (sql) =>
          sql.includes("FROM support_time_grants WHERE id=$1")
            ? [{ ...grant, ...change }]
            : undefined,
      }).time.revoke(token, grantId),
    ).toEqual({ kind: "denied" });
});
