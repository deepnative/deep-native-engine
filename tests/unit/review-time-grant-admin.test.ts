import { beforeEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { reviewTimeGrantAdminStore } from "../../src/review-time-grant-admin.ts";
import type { SampleAssignmentContext } from "../../src/sample-assignment-transaction.ts";
import { sampleAssignmentCursor } from "../../src/sample-assignment-cursor.ts";
import { REVIEW_GRANT_PATH } from "../../src/review-time-grant-values.ts";
const m = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  eligible: vi.fn(),
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
vi.mock("../../src/sample-assignment-source.ts", () => ({
  sampleAssignmentEligible: m.eligible,
}));
vi.mock("../../src/review-time-grant-history.ts", () => ({
  reviewGrantCandidates: m.candidates,
  reviewGrantHistoryLocks: m.locks,
  reviewGrantProject: m.project,
}));
vi.mock("../../src/review-time-grants.ts", () => ({
  createReviewTimeGrantRecord: m.create,
  revokeReviewTimeGrantRecord: m.revoke,
}));
const allocation = "11111111-1111-4111-8111-111111111111",
  reviewer = "22222222-2222-4222-8222-222222222222",
  operation = "33333333-3333-4333-8333-333333333333",
  grantId = "44444444-4444-4444-8444-444444444444",
  token = "a".repeat(64),
  secret = Buffer.alloc(32, 4);
const refs = { allocationId: allocation, reviewerId: reviewer },
  input = {
    ...refs,
    operationId: operation,
    startsAt: "2090-01-01T00:00:00.000Z",
    expiresAt: "2090-01-01T01:00:00.000Z",
  },
  end = new Date("2090-01-02T00:00:00Z");
const candidate = {
  ...refs,
  grantId,
  operationId: operation,
  ownerId: "owner",
  workspaceId: "workspace",
  evidenceId: "source",
  submissionId: "submission",
  sourceRevision: 1,
  startsAt: new Date(input.startsAt),
  expiresAt: new Date(input.expiresAt),
  createdAt: new Date(input.startsAt),
  at: "2090-01-01T00:00:00.000000Z",
};
const row = {
  ...refs,
  grantId,
  sourceRevision: 1,
  allocationState: "allocated",
  ceiling: 20,
  startsAt: input.startsAt,
  expiresAt: input.expiresAt,
  createdAt: input.startsAt,
  revokedAt: null,
  state: "active",
  sourceAvailable: true,
  canRevoke: true,
};
const c: SampleAssignmentContext = {
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
const store = () =>
  reviewTimeGrantAdminStore(
    {} as Pool,
    { mode: "test", administration: "enabled" },
    secret,
  );
beforeEach(() => {
  vi.resetAllMocks();
  c.expires = [];
  m.execute.mockImplementation(
    async (
      _pool,
      _token,
      _writing,
      use: (c: SampleAssignmentContext) => Promise<object>,
    ) => {
      try {
        return { ...(await use(c)), deadline: 1000 };
      } catch (e) {
        return { kind: (e as { kind: string }).kind };
      }
    },
  );
  m.actors.mockResolvedValue({
    principals: new Map([["admin", { expires: end }]]),
    profiles: new Map(),
  });
  m.eligible.mockResolvedValue({
    submissionId: "submission",
    reviewerExpires: end,
  });
  m.candidates.mockResolvedValue([]);
  m.project.mockResolvedValue(row);
  m.create.mockResolvedValue(grantId);
  m.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith('SELECT id AS "allocationId"')
      ? [candidate]
      : sql.startsWith("SELECT ceiling")
        ? [{ ceiling: 20 }]
        : [],
  }));
});
it("REVIEW-GRANT-01/02 exposes safe current check and self reference without mutating grants or units", async () => {
  expect(await store().open(token)).toEqual({
    kind: "ready",
    creationEnabled: true,
    deadline: 1000,
  });
  expect(await store().selfReference(token)).toMatchObject({
    kind: "ready",
    reference: { reviewerId: "admin", expiresAt: end.toISOString() },
  });
  expect(m.actors).toHaveBeenLastCalledWith(c, [], false, "reviewer");
  expect(await store().check(token, refs)).toMatchObject({
    kind: "ready",
    check: {
      ...refs,
      sourceRevision: 1,
      allocationState: "allocated",
      ceiling: 20,
      authorityExpiresAt: end.toISOString(),
    },
  });
  expect(m.create).not.toHaveBeenCalled();
  expect(m.revoke).not.toHaveBeenCalled();
});
it.each(["disabled", "live"] as const)(
  "REVIEW-GRANT-05 %s gates every public operation before DB access",
  async (mode) => {
    const s = reviewTimeGrantAdminStore({} as Pool, {
      mode: mode === "live" ? "live" : "test",
      administration: mode === "disabled" ? "disabled" : "enabled",
    });
    for (const result of [
      await s.open(token),
      await s.selfReference(token),
      await s.check(token, refs),
      await s.grant(token, input),
      await s.history(token),
      await s.receipt(token, grantId),
      await s.recover(token, operation),
      await s.revoke(token, { grantId, operationId: operation }),
      await s.recoverRevoke(token, operation),
    ])
      expect(result).toEqual({ kind: "unavailable" });
    expect(m.execute).not.toHaveBeenCalled();
  },
);
it("REVIEW-GRANT-06 recovery-only retains current-authority read/revoke while creation and reference are paused", async () => {
  const s = reviewTimeGrantAdminStore({} as Pool, {
    mode: "test",
    administration: "recovery-only",
  });
  expect(await s.open(token)).toMatchObject({
    kind: "ready",
    creationEnabled: false,
  });
  expect(await s.selfReference(token)).toEqual({ kind: "unavailable" });
  expect(await s.check(token, refs)).toEqual({ kind: "unavailable" });
  expect(await s.grant(token, input)).toEqual({ kind: "unavailable" });
  expect((await s.history(token)).kind).toBe("ready");
  expect((await s.recover(token, operation)).kind).toBe("absent");
  expect((await s.recoverRevoke(token, operation)).kind).toBe("absent");
  expect(
    (await s.revoke(token, { grantId, operationId: operation })).kind,
  ).toBe("denied");
});
it("REVIEW-GRANT-05 malformed operations/cursors fail before connection", async () => {
  const s = store();
  for (const result of [
    await s.check(token, { ...refs, allocationId: "bad" }),
    await s.grant(token, { ...input, operationId: "bad" }),
    await s.history(token, "bad"),
    await s.receipt(token, "bad"),
    await s.recover(token, "bad"),
    await s.revoke(token, { grantId: "bad", operationId: operation }),
    await s.recoverRevoke(token, "bad"),
  ])
    expect(result).toEqual({ kind: "invalid" });
  expect(m.execute).not.toHaveBeenCalled();
});
it.each([undefined, { ...candidate, evidenceId: null }])(
  "REVIEW-GRANT-05 absent allocation/source is denied after current actor authority",
  async (allocation) => {
    m.query.mockResolvedValue({ rows: allocation ? [allocation] : [] });
    expect((await store().check(token, refs)).kind).toBe("denied");
    expect(m.eligible).not.toHaveBeenCalled();
    expect((await store().grant(token, input)).kind).toBe("denied");
    expect(m.create).not.toHaveBeenCalled();
  },
);
it("REVIEW-GRANT-05 changed allocation/source eligibility cannot be confirmed", async () => {
  m.query.mockImplementation(async (sql: string) => ({
    rows: sql.startsWith("SELECT id AS") ? [candidate] : [],
  }));
  expect((await store().check(token, refs)).kind).toBe("denied");
});
it("REVIEW-GRANT-02 creates one shared writer record only after finite admin/reviewer authority", async () => {
  m.candidates
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([candidate]);
  expect(await store().grant(token, input)).toEqual({
    kind: "applied",
    row,
    deadline: 1000,
  });
  expect(m.actors).toHaveBeenCalledWith(c, [reviewer, "owner"], true);
  expect(m.create).toHaveBeenCalledWith(
    c.tx,
    "admin",
    allocation,
    reviewer,
    new Date(input.startsAt),
    new Date(input.expiresAt),
    operation,
  );
  expect(c.expires).toEqual([new Date(input.expiresAt)]);
});
it("REVIEW-GRANT-02 refuses excess finite window and missing retained writer receipt", async () => {
  m.eligible.mockResolvedValueOnce({
    submissionId: "submission",
    reviewerExpires: new Date(input.startsAt),
  });
  expect((await store().grant(token, input)).kind).toBe("denied");
  expect(m.create).not.toHaveBeenCalled();
  expect((await store().grant(token, input)).kind).toBe("denied");
  expect(m.create).toHaveBeenCalledTimes(1);
});
it.each(["allocationId", "reviewerId", "startsAt", "expiresAt"] as const)(
  "REVIEW-GRANT-06 changed %s conflicts with retained operation without leaking projection",
  async (field) => {
    const changed = {
      ...candidate,
      [field]: field.endsWith("At") ? end : operation,
    };
    m.candidates.mockResolvedValue([changed]);
    expect((await store().grant(token, input)).kind).toBe("conflict");
    expect(m.actors).toHaveBeenCalledWith(c, [], true);
    expect(m.project).not.toHaveBeenCalled();
    m.candidates.mockResolvedValueOnce([]).mockResolvedValueOnce([changed]);
    expect((await store().grant(token, input)).kind).toBe("conflict");
  },
);
it("REVIEW-GRANT-06 exact replay reads retained permission without new grant/audit", async () => {
  m.candidates.mockResolvedValue([candidate]);
  expect(await store().grant(token, input)).toEqual({
    kind: "replayed",
    row,
    deadline: 1000,
  });
  expect(m.eligible).not.toHaveBeenCalled();
  expect(m.create).not.toHaveBeenCalled();
});
it.each([
  undefined,
  { ...candidate, ownerId: "other" },
  { ...candidate, workspaceId: "other" },
])(
  "REVIEW-GRANT-05 refuses an expanded source lock set after a concurrent operation winner",
  async (allocation) => {
    m.query.mockResolvedValue({ rows: allocation ? [allocation] : [] });
    m.candidates.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate]);
    expect((await store().grant(token, input)).kind).toBe("denied");
    expect(m.project).not.toHaveBeenCalled();
  },
);
it("REVIEW-GRANT-07 reads bounded own history and authenticated continuation with original deadline", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({
    ...candidate,
    grantId: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
  }));
  m.candidates.mockResolvedValue(rows);
  const result = await store().history(token);
  if (result.kind !== "ready") throw Error("history expected");
  expect(result.history.rows).toHaveLength(20);
  expect(m.project).toHaveBeenCalledTimes(20);
  const decoded = sampleAssignmentCursor(secret).decode(
    token,
    { evidenceId: REVIEW_GRANT_PATH, sourceRevision: 1 },
    result.history.next!,
  );
  if (!decoded || decoded === "invalid") throw Error("cursor expected");
  expect(decoded.id).toBe(rows[19]!.grantId);
  await store().history(token, result.history.next!);
  expect(c.expires).toEqual([new Date(decoded.expires)]);
  m.candidates.mockResolvedValue([]);
  expect(await store().history(token)).toMatchObject({
    kind: "ready",
    history: { rows: [], next: null },
  });
});
it("REVIEW-GRANT-06/07 scopes receipt and create recovery to own actor; absent remains explicit unknown", async () => {
  expect((await store().receipt(token, grantId)).kind).toBe("absent");
  m.candidates.mockResolvedValue([candidate]);
  expect(await store().recover(token, operation)).toMatchObject({
    kind: "ready",
    row,
  });
  expect(m.candidates).toHaveBeenLastCalledWith(
    c,
    expect.stringContaining("g.granted_by=$1 AND g.idempotency_key=$2"),
    ["admin", operation],
  );
});
it("REVIEW-GRANT-04/06 records explicit revoke once, then preserves unchanged observations without another grant audit", async () => {
  m.candidates.mockResolvedValue([candidate]);
  m.project.mockResolvedValueOnce(row).mockResolvedValue({
    ...row,
    canRevoke: false,
    revokedAt: input.startsAt,
    state: "revoked",
  });
  const first = await store().revoke(token, {
    grantId,
    operationId: operation,
  });
  expect(first).toMatchObject({
    kind: "revoked",
    outcome: "revoked",
    row: { state: "revoked" },
  });
  expect(m.revoke).toHaveBeenCalledTimes(1);
  expect(m.locks).toHaveBeenCalledWith(c, [candidate], true);
  expect(m.query).toHaveBeenCalledWith(
    expect.stringContaining("INSERT INTO review_time_grant_revocations"),
    expect.arrayContaining([
      "admin",
      operation,
      grantId,
      allocation,
      "revoked",
      input.startsAt,
    ]),
  );
  expect(
    await store().revoke(token, { grantId, operationId: operation }),
  ).toMatchObject({ kind: "unchanged", outcome: "unchanged" });
  expect(m.revoke).toHaveBeenCalledTimes(1);
});
it("REVIEW-GRANT-06 exact revoke replay and original recovery retain ordinary receipt and outcome", async () => {
  m.query.mockResolvedValue({
    rows: [{ grantId, revocationReceiptId: "receipt", outcome: "revoked" }],
  });
  m.candidates.mockResolvedValue([candidate]);
  expect(
    await store().revoke(token, { grantId, operationId: operation }),
  ).toMatchObject({
    kind: "replayed",
    revocationReceiptId: "receipt",
    outcome: "revoked",
    row,
  });
  expect(m.revoke).not.toHaveBeenCalled();
  expect(await store().recoverRevoke(token, operation)).toMatchObject({
    kind: "ready",
    revocationReceiptId: "receipt",
    outcome: "revoked",
  });
  m.candidates.mockResolvedValue([]);
  expect((await store().recoverRevoke(token, operation)).kind).toBe("absent");
});
it("REVIEW-GRANT-06 rejects changed revoke operation payload, including a concurrent winner", async () => {
  m.query.mockResolvedValue({ rows: [{ grantId: allocation }] });
  expect(
    (await store().revoke(token, { grantId, operationId: operation })).kind,
  ).toBe("conflict");
  expect(m.actors).toHaveBeenCalledWith(c, [], true);
  m.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ grantId: allocation }] });
  expect(
    (await store().revoke(token, { grantId, operationId: operation })).kind,
  ).toBe("conflict");
  expect(m.revoke).not.toHaveBeenCalled();
});
