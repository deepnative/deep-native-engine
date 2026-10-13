import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { supportTimeGrantAdminStore } from "../../src/support-time-grant-admin.ts";
import type { SampleAssignmentContext } from "../../src/sample-assignment-transaction.ts";
const m = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  candidates: vi.fn(),
  locks: vi.fn(),
  project: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
  query: vi.fn(),
  observe: vi.fn(),
}));
vi.mock("../../src/sample-assignment-transaction.ts", async (original) => ({
  ...(await original<
    typeof import("../../src/sample-assignment-transaction.ts")
  >()),
  sampleAssignmentExecute: m.execute,
  sampleAssignmentActors: m.actors,
}));
vi.mock("../../src/support-time-grant-history.ts", () => ({
  supportMinuteCandidates: m.candidates,
  supportMinuteLocks: m.locks,
  supportMinuteProject: m.project,
}));
vi.mock("../../src/support-time-grant-records.ts", () => ({
  createSupportTimeGrantRecord: m.create,
  revokeSupportTimeGrantRecord: m.revoke,
}));
const id = "11111111-1111-4111-8111-111111111111",
  operatorId = "22222222-2222-4222-8222-222222222222",
  operationId = "33333333-3333-4333-8333-333333333333",
  grantId = "44444444-4444-4444-8444-444444444444",
  token = "a".repeat(64),
  end = new Date("2090-01-02T00:00:00Z");
const refs = { requestId: id, allocationId: id, operatorId },
  input = {
    ...refs,
    operationId,
    startsAt: "2090-01-01T00:00:00.000Z",
    expiresAt: "2090-01-01T01:00:00.000Z",
  };
const candidate = {
  ...refs,
  grantId,
  operationId,
  ownerId: "owner",
  workspaceId: "workspace",
  startsAt: new Date(input.startsAt),
  expiresAt: new Date(input.expiresAt),
  createdAt: new Date(input.startsAt),
  at: "2090-01-01T00:00:00.000000Z",
};
const row = {
  ...refs,
  grantId,
  role: "operator",
  ceiling: 20,
  allocationState: "allocated",
  startsAt: input.startsAt,
  expiresAt: input.expiresAt,
  createdAt: input.startsAt,
  revokedAt: null as string | null,
  state: "active",
  sourceAvailable: true,
  canRevoke: true,
};
const context: SampleAssignmentContext = {
  actorId: "admin",
  credentialHash: "hash",
  expires: [],
  tx: {
    query: m.query,
    observe: m.observe,
    bounded: vi.fn(),
    deadline: () => 1000,
  },
};
const actors = () => ({
  principals: new Map([
    ["admin", { id: "admin", kind: "staff", revoked: null, expires: end }],
    [
      operatorId,
      { id: operatorId, kind: "staff", revoked: null, expires: end },
    ],
    ["owner", { id: "owner", kind: "member", revoked: null, expires: end }],
  ]),
  profiles: new Map([
    ["admin", "platform_admin"],
    [operatorId, "operator"],
  ]),
});
const store = (
  administration: "enabled" | "disabled" | "recovery-only" = "enabled",
  writes = true,
  mode: "test" | "live" = "test",
) =>
  supportTimeGrantAdminStore(
    {} as Pool,
    { mode, administration, writes },
    Buffer.alloc(32, 4),
  );
beforeEach(() => {
  vi.resetAllMocks();
  context.expires = [];
  m.execute.mockImplementation(async (_pool, _token, _writing, use) => {
    try {
      return { ...(await use(context)), deadline: 1000 };
    } catch (error) {
      return { kind: (error as { kind: string }).kind };
    }
  });
  m.actors.mockImplementation(actors);
  m.candidates.mockResolvedValue([]);
  m.locks.mockResolvedValue(undefined);
  m.project.mockResolvedValue(row);
  m.create.mockResolvedValue(grantId);
  m.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith("SELECT a.id AS")
      ? [candidate]
      : sql.startsWith("SELECT ceiling")
        ? [{ ceiling: 20 }]
        : sql.startsWith("SELECT id FROM")
          ? [{ id }]
          : [],
  }));
});
it("SUPPORT-GRANT-01/02 current check and portal admission create no permission or allowance", async () => {
  expect(await store().open(token)).toMatchObject({
    kind: "ready",
    creationEnabled: true,
    writesEnabled: true,
  });
  expect(await store().check(token, refs)).toMatchObject({
    kind: "ready",
    check: { ...refs, ceiling: 20, authorityExpiresAt: end.toISOString() },
  });
  expect(m.create).not.toHaveBeenCalled();
  expect(m.revoke).not.toHaveBeenCalled();
});
it.each(["disabled", "live", "paused"] as const)(
  "SUPPORT-GRANT-08 %s gates mutation without database writes",
  async (mode) => {
    const s = store(
      mode === "disabled" ? "disabled" : "enabled",
      mode !== "paused",
      mode === "live" ? "live" : "test",
    );
    expect(await s.grant(token, input)).toEqual({ kind: "unavailable" });
    expect(await s.revoke(token, { grantId, operationId })).toEqual({
      kind: "unavailable",
    });
    if (mode === "paused") {
      expect(await s.open(token)).toMatchObject({
        kind: "ready",
        creationEnabled: false,
        writesEnabled: false,
      });
      return;
    }
    for (const result of [
      await s.open(token),
      await s.check(token, refs),
      await s.history(token),
      await s.exact(token, id),
      await s.recover(token, operationId),
      await s.recoverRevocation(token, operationId),
    ])
      expect(result).toEqual({ kind: "unavailable" });
    expect(m.execute).not.toHaveBeenCalled();
  },
);
it("SUPPORT-GRANT-06 malformed references, windows and cursors are rejected before connection", async () => {
  const s = store();
  for (const result of [
    await s.check(token, { ...refs, requestId: "bad" }),
    await s.grant(token, { ...input, operationId: "bad" }),
    await s.history(token, "bad"),
    await s.exact(token, "bad"),
    await s.recover(token, "bad"),
    await s.revoke(token, { grantId: "bad", operationId }),
    await s.recoverRevocation(token, "bad"),
  ])
    expect(result).toEqual({ kind: "invalid" });
  expect(m.execute).not.toHaveBeenCalled();
});
it("SUPPORT-GRANT-02/06 missing source, mismatched roles and withdrawn authority cannot create permission", async () => {
  for (const change of [
    "missing",
    "self",
    "target-missing",
    "target-member",
    "target-revoked",
    "target-role",
    "owner-missing",
    "owner-staff",
    "owner-revoked",
    "workspace",
    "request",
    "allocation",
  ]) {
    const a = actors();
    m.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("SELECT a.id AS")
        ? change === "missing"
          ? []
          : [candidate]
        : sql.startsWith("SELECT ceiling")
          ? change === "allocation"
            ? []
            : [{ ceiling: 20 }]
          : sql.startsWith("SELECT id FROM")
            ? (change === "workspace" && sql.includes("workspaces")) ||
              (change === "request" && sql.includes("support_requests"))
              ? []
              : [{ id }]
            : [],
    }));
    if (change === "target-missing") a.principals.delete(operatorId);
    if (change === "target-member")
      a.principals.get(operatorId)!.kind = "member";
    if (change === "target-revoked")
      Object.assign(a.principals.get(operatorId)!, { revoked: end });
    if (change === "target-role") a.profiles.set(operatorId, "coach");
    if (change === "owner-missing") a.principals.delete("owner");
    if (change === "owner-staff") a.principals.get("owner")!.kind = "staff";
    if (change === "owner-revoked")
      Object.assign(a.principals.get("owner")!, { revoked: end });
    m.actors.mockResolvedValue(a);
    expect(
      (
        await store().check(token, {
          ...refs,
          operatorId: change === "self" ? "admin" : operatorId,
        })
      ).kind,
    ).toBe(change === "self" ? "invalid" : "denied");
  }
  expect(m.create).not.toHaveBeenCalled();
});
it("SUPPORT-GRANT-02 finite creation rejects an overlong window and preserves exact scheduled input", async () => {
  expect(
    (
      await store().grant(token, {
        ...input,
        expiresAt: "2090-01-03T00:00:00.000Z",
      })
    ).kind,
  ).toBe("invalid");
  expect(m.create).not.toHaveBeenCalled();
  m.candidates
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([candidate]);
  expect(await store().grant(token, input)).toMatchObject({
    kind: "applied",
    row,
  });
});
it.each([
  "requestId",
  "allocationId",
  "operatorId",
  "startsAt",
  "expiresAt",
] as const)(
  "SUPPORT-GRANT-04 changing %s conflicts with retained payload",
  async (field) => {
    const changed = {
      ...candidate,
      [field]: field.endsWith("At") ? end : grantId,
    };
    m.candidates.mockResolvedValue([changed]);
    expect((await store().grant(token, input)).kind).toBe("conflict");
    expect(m.project).not.toHaveBeenCalled();
    m.candidates.mockResolvedValueOnce([]).mockResolvedValueOnce([changed]);
    expect((await store().grant(token, input)).kind).toBe("conflict");
    expect(m.create).not.toHaveBeenCalled();
  },
);
it("SUPPORT-GRANT-04 exact replay is readback; revocation prevents resurrection and a changed source lock set is withheld", async () => {
  m.candidates.mockResolvedValue([candidate]);
  expect(await store().grant(token, input)).toMatchObject({
    kind: "replayed",
    row,
  });
  expect(m.create).not.toHaveBeenCalled();
  m.project.mockResolvedValue({ ...row, revokedAt: input.startsAt });
  expect((await store().grant(token, input)).kind).toBe("conflict");
  m.candidates.mockResolvedValue([{ ...candidate, workspaceId: "changed" }]);
  expect((await store().grant(token, input)).kind).toBe("denied");
  m.query.mockResolvedValue({ rows: [] });
  expect((await store().grant(token, input)).kind).toBe("denied");
});
it("SUPPORT-GRANT-08 recovery-only preserves existing operations and pauses fresh creation", async () => {
  const s = store("recovery-only");
  expect(await s.check(token, refs)).toEqual({ kind: "unavailable" });
  expect((await s.grant(token, input)).kind).toBe("unavailable");
  m.candidates.mockResolvedValue([candidate]);
  expect((await s.grant(token, input)).kind).toBe("replayed");
});
it("SUPPORT-GRANT-07 bounded own pagination retains original continuation expiry; original recovery remains distinct from absence", async () => {
  const s = store();
  expect((await s.exact(token, grantId)).kind).toBe("absent");
  expect(await s.history(token)).toMatchObject({
    kind: "ready",
    rows: [],
    next: null,
  });
  const rows = Array.from({ length: 21 }, (_, i) => ({
    ...candidate,
    grantId: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
  }));
  m.candidates.mockResolvedValue(rows);
  const first = await s.history(token);
  if (first.kind !== "ready") throw Error("Own history required");
  expect(first.rows).toHaveLength(20);
  expect(first.next).toBeTruthy();
  expect((await s.history(token, first.next!)).kind).toBe("ready");
  expect(context.expires.length).toBe(1);
  m.candidates.mockResolvedValue([candidate]);
  expect(await s.recover(token, operationId)).toMatchObject({
    kind: "ready",
    row,
  });
});
it("SUPPORT-GRANT-04/05 exact revocation stores original changed/unchanged outcomes, replay and foreign-source denial", async () => {
  const s = store();
  expect((await s.revoke(token, { grantId, operationId })).kind).toBe("denied");
  m.candidates.mockResolvedValue([candidate]);
  m.project
    .mockResolvedValueOnce(row)
    .mockResolvedValue({ ...row, revokedAt: input.startsAt, state: "revoked" });
  expect(await s.revoke(token, { grantId, operationId })).toMatchObject({
    kind: "applied",
    revocation: { outcome: "revoked" },
  });
  expect(await s.revoke(token, { grantId, operationId })).toMatchObject({
    kind: "applied",
    revocation: { outcome: "unchanged" },
  });
  m.query.mockResolvedValue({
    rows: [{ grantId, revocationReceiptId: id, outcome: "revoked" }],
  });
  expect(await s.revoke(token, { grantId, operationId })).toMatchObject({
    kind: "replayed",
    revocation: { outcome: "revoked" },
  });
  expect(await s.recoverRevocation(token, operationId)).toMatchObject({
    kind: "ready",
    revocation: { outcome: "revoked" },
  });
  m.candidates.mockResolvedValue([]);
  expect((await s.recoverRevocation(token, operationId)).kind).toBe("denied");
  m.query.mockResolvedValue({ rows: [{ grantId: id }] });
  expect((await s.revoke(token, { grantId, operationId })).kind).toBe(
    "conflict",
  );
  m.query.mockResolvedValue({ rows: [] });
  expect((await s.recoverRevocation(token, operationId)).kind).toBe("absent");
});
