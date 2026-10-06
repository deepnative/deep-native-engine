import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { sampleAssignmentStore } from "../../src/sample-assignment.ts";
import { sampleAssignmentCursor } from "../../src/sample-assignment-cursor.ts";
import type { SampleAssignmentCandidate } from "../../src/sample-assignment-history.ts";
import type { SampleAssignmentContext } from "../../src/sample-assignment-transaction.ts";
const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  discover: vi.fn(),
  eligible: vi.fn(),
  candidates: vi.fn(),
  locks: vi.fn(),
  project: vi.fn(),
  query: vi.fn(),
  observe: vi.fn(),
}));
vi.mock(
  "../../src/sample-assignment-transaction.ts",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/sample-assignment-transaction.ts")
    >()),
    sampleAssignmentExecute: mocks.execute,
    sampleAssignmentActors: mocks.actors,
  }),
);
vi.mock("../../src/sample-assignment-source.ts", () => ({
  sampleAssignmentDiscover: mocks.discover,
  sampleAssignmentEligible: mocks.eligible,
}));
vi.mock("../../src/sample-assignment-history.ts", () => ({
  sampleAssignmentCandidates: mocks.candidates,
  sampleAssignmentHistoryLocks: mocks.locks,
  sampleAssignmentProject: mocks.project,
}));
const id = "11111111-1111-4111-8111-111111111111",
  reviewer = "22222222-2222-4222-8222-222222222222",
  operation = "33333333-3333-4333-8333-333333333333";
const input = {
  evidenceId: id,
  sourceRevision: 1,
  reviewerId: reviewer,
  operationId: operation,
  startsAt: "2090-01-01T00:00:00.000Z",
  expiresAt: "2090-01-01T01:00:00.000Z",
};
const refs = { evidenceId: id, sourceRevision: 1, reviewerId: reviewer },
  source = { evidenceId: id, sourceRevision: 1 };
const token = "a".repeat(64),
  secret = Buffer.alloc(32, 1),
  pool = {} as Pool;
const context: SampleAssignmentContext = {
  actorId: "admin",
  credentialHash: "hash",
  expires: [],
  tx: {
    query: mocks.query,
    observe: mocks.observe,
    bounded: vi.fn(),
    deadline: () => 1000,
  },
};
const end = new Date("2090-01-02T00:00:00Z");
const candidate: SampleAssignmentCandidate = {
  receiptId: "receipt",
  workspaceId: "workspace",
  ownerId: "owner",
  administratorId: "admin",
  operationId: operation,
  ...refs,
  submissionId: "submission",
  assignmentId: "assignment",
  exactGrantId: operation,
  startsAt: new Date(input.startsAt),
  expiresAt: new Date(input.expiresAt),
  createdAt: new Date(input.startsAt),
  at: "2090-01-01T00:00:00.000000Z",
};
const publicRow = {
  ...refs,
  receiptId: "receipt",
  exactGrantId: operation,
  startsAt: input.startsAt,
  expiresAt: input.expiresAt,
  createdAt: input.startsAt,
  revokedAt: null,
  state: "active",
  canRevoke: true,
};
const store = () =>
  sampleAssignmentStore(pool, { enabled: true, mode: "test" }, secret);
beforeEach(() => {
  vi.resetAllMocks();
  context.expires = [];
  mocks.execute.mockImplementation(
    async (
      _pool,
      _token,
      _writing,
      use: (c: SampleAssignmentContext) => Promise<object>,
    ) => {
      try {
        return { ...(await use(context)), deadline: 1000 };
      } catch (error) {
        return { kind: (error as { kind: string }).kind };
      }
    },
  );
  mocks.actors.mockResolvedValue({
    principals: new Map([["admin", { expires: end }]]),
  });
  mocks.discover.mockResolvedValue({
    workspaceId: "workspace",
    ownerId: "owner",
  });
  mocks.eligible.mockResolvedValue({
    workspaceId: "workspace",
    ownerId: "owner",
    submissionId: "submission",
    reviewerExpires: end,
  });
  mocks.candidates.mockResolvedValue([]);
  mocks.project.mockResolvedValue(publicRow);
  mocks.query.mockResolvedValue({ rows: [{ id }] });
});
it("opens only current authorized forms and projects the reviewer's own reference", async () => {
  expect(await store().open(token)).toEqual({ kind: "ready", deadline: 1000 });
  expect(await store().selfReference(token)).toEqual({
    kind: "ready",
    deadline: 1000,
    reference: { reviewerId: "admin", expiresAt: end.toISOString() },
  });
  expect(mocks.actors).toHaveBeenLastCalledWith(context, [], false, "reviewer");
  expect(await store().check(token, refs)).toEqual({
    kind: "ready",
    deadline: 1000,
    check: {
      ...refs,
      sourceStatus: "eligible",
      reviewerExpiresAt: end.toISOString(),
    },
  });
  expect(mocks.actors).toHaveBeenLastCalledWith(context, [reviewer, "owner"]);
});
it("missing check references still establish current administrator authority without a made-up owner", async () => {
  mocks.discover.mockResolvedValue(undefined);
  mocks.eligible.mockRejectedValue({ kind: "denied" });
  expect(await store().check(token, refs)).toEqual({ kind: "denied" });
  expect(mocks.actors).toHaveBeenCalledWith(context, [reviewer]);
});
it.each(["live", "disabled"])(
  "%s blocks creation and new entry independently; local rollback retains trusted ports",
  async (mode) => {
    const selected = sampleAssignmentStore(pool, {
      enabled: mode !== "disabled",
      mode: mode === "live" ? "live" : "test",
    });
    expect(await selected.open(token)).toEqual({ kind: "unavailable" });
    expect(await selected.selfReference(token)).toEqual({
      kind: "unavailable",
    });
    expect(await selected.check(token, refs)).toEqual({ kind: "unavailable" });
    expect(await selected.assign(token, input)).toEqual({
      kind: "unavailable",
    });
    if (mode === "live") {
      expect(await selected.history(token, source)).toEqual({
        kind: "unavailable",
      });
      expect(await selected.recover(token, operation)).toEqual({
        kind: "unavailable",
      });
      expect(await selected.revoke(token, source, operation)).toEqual({
        kind: "unavailable",
      });
      expect(mocks.execute).not.toHaveBeenCalled();
    } else {
      expect((await selected.history(token, source)).kind).toBe("ready");
      expect((await selected.recover(token, operation)).kind).toBe("absent");
      expect((await selected.revoke(token, source, operation)).kind).toBe(
        "denied",
      );
    }
  },
);
it("rejects invalid fields and cursors before requesting authority or a connection", async () => {
  expect(await store().check(token, { ...refs, sourceRevision: 0 })).toEqual({
    kind: "invalid",
  });
  expect(await store().assign(token, { ...input, operationId: "bad" })).toEqual(
    { kind: "invalid" },
  );
  expect(
    await store().history(token, { ...source, sourceRevision: 0 }),
  ).toEqual({ kind: "invalid" });
  expect(await store().history(token, source, "bad")).toEqual({
    kind: "invalid",
  });
  expect(await store().recover(token, "bad")).toEqual({ kind: "invalid" });
  expect(
    await store().revoke(token, { ...source, sourceRevision: 0 }, operation),
  ).toEqual({ kind: "invalid" });
  expect(await store().revoke(token, source, "bad")).toEqual({
    kind: "invalid",
  });
  expect(mocks.execute).not.toHaveBeenCalled();
});
it("writes a dedicated pair, both compatible audits and immutable receipt under the serialized administrator", async () => {
  mocks.candidates
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([candidate]);
  expect(await store().assign(token, input)).toEqual({
    kind: "applied",
    row: publicRow,
    deadline: 1000,
  });
  expect(mocks.actors).toHaveBeenCalledWith(context, [reviewer, "owner"], true);
  expect(context.expires).toEqual([new Date(input.expiresAt)]);
  expect(
    mocks.query.mock.calls.map(
      (call) => (call[0] as string).match(/INSERT INTO (\w+)/)![1],
    ),
  ).toEqual([
    "assignment_grants",
    "reviewer_evidence_grants",
    "authorization_audit",
    "private_sample_assignment_operations",
  ]);
  const receiptValues = mocks.query.mock.calls[3]![1] as unknown[];
  expect(receiptValues.slice(1, 8)).toEqual([
    "workspace",
    "admin",
    operation,
    reviewer,
    id,
    1,
    "submission",
  ]);
  expect(receiptValues.slice(-2)).toEqual([input.startsAt, input.expiresAt]);
});
it("denies missing source, excess authority or missing receipt rather than returning invented success", async () => {
  mocks.discover.mockResolvedValue(undefined);
  mocks.eligible.mockRejectedValueOnce({ kind: "denied" });
  expect((await store().assign(token, input)).kind).toBe("denied");
  expect(mocks.actors).toHaveBeenLastCalledWith(context, [reviewer], true);
  mocks.eligible.mockResolvedValue({
    ...candidate,
    reviewerExpires: new Date(input.startsAt),
  });
  expect((await store().assign(token, input)).kind).toBe("denied");
  expect(mocks.query).not.toHaveBeenCalled();
  mocks.eligible.mockResolvedValue({
    workspaceId: "workspace",
    submissionId: "submission",
    reviewerExpires: end,
  });
  expect((await store().assign(token, input)).kind).toBe("denied");
});
it("reports existing foreign-payload conflict after current admin lock without touching that source", async () => {
  mocks.candidates.mockResolvedValue([{ ...candidate, reviewerId: id }]);
  expect(await store().assign(token, input)).toEqual({
    kind: "conflict",
    deadline: 1000,
  });
  expect(mocks.actors).toHaveBeenCalledWith(context, [], true);
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(mocks.project).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
it.each([
  "evidenceId",
  "sourceRevision",
  "reviewerId",
  "startsAt",
  "expiresAt",
] as const)(
  "a concurrent key winner with changed %s conflicts without its projection",
  async (field) => {
    const changed = {
      ...candidate,
      [field]:
        field === "sourceRevision" ? 2 : field.endsWith("At") ? end : operation,
    };
    if (field === "reviewerId") changed.reviewerId = id;
    mocks.candidates.mockResolvedValueOnce([]).mockResolvedValueOnce([changed]);
    expect((await store().assign(token, input)).kind).toBe("conflict");
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  },
);
it("identical retained operation projects historical state without inspecting source eligibility or creating new grants", async () => {
  mocks.candidates.mockResolvedValue([candidate]);
  expect(await store().assign(token, input)).toEqual({
    kind: "replayed",
    row: publicRow,
    deadline: 1000,
  });
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(mocks.eligible).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.locks).toHaveBeenCalledWith(context, [candidate]);
});
it.each([
  undefined,
  { ownerId: "different", workspaceId: "workspace" },
  { ownerId: "owner", workspaceId: "different" },
])(
  "does not expand source lock scope after a concurrent receipt appears",
  async (discovered) => {
    mocks.discover.mockResolvedValue(discovered);
    mocks.candidates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([candidate]);
    expect((await store().assign(token, input)).kind).toBe("denied");
    expect(mocks.locks).not.toHaveBeenCalled();
  },
);
it("reads 20 structural rows with a bound cursor and preserves its original expiry on continuation", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({
    ...candidate,
    exactGrantId: `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
  }));
  mocks.candidates.mockResolvedValue(rows);
  const result = await store().history(token, source);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("History expected");
  expect(result.history.rows).toHaveLength(20);
  expect(mocks.project).toHaveBeenCalledTimes(20);
  const decoded = sampleAssignmentCursor(secret).decode(
    token,
    source,
    result.history.next!,
  );
  expect(decoded).not.toBe("invalid");
  if (!decoded || decoded === "invalid") throw Error("Cursor expected");
  expect(decoded.id).toBe(rows[19]!.exactGrantId);
  const continued = await store().history(token, source, result.history.next!);
  if (continued.kind !== "ready") throw Error("Continuation expected");
  expect(
    sampleAssignmentCursor(secret).decode(
      token,
      source,
      continued.history.next!,
    ),
  ).toEqual(decoded);
  expect(context.expires).toEqual([new Date(decoded.expires)]);
});
it("returns final history without a cursor and validates an empty source page in source-first order", async () => {
  mocks.candidates.mockResolvedValueOnce([candidate]);
  expect(await store().history(token, source)).toMatchObject({
    kind: "ready",
    history: { rows: [publicRow], next: null },
  });
  expect(await store().history(token, source)).toMatchObject({
    kind: "ready",
    history: { rows: [], next: null },
  });
  expect(
    mocks.query.mock.calls.map(
      (call) => (call[0] as string).match(/FROM (\w+)/)![1],
    ),
  ).toEqual(["workspaces", "evidence_objects"]);
});
it.each(["discovery", "workspace", "source"])(
  "empty history denies absent %s without metadata",
  async (level) => {
    if (level === "discovery") mocks.discover.mockResolvedValue(undefined);
    if (level === "workspace") mocks.query.mockResolvedValueOnce({ rows: [] });
    if (level === "source")
      mocks.query
        .mockResolvedValueOnce({ rows: [{ id }] })
        .mockResolvedValueOnce({ rows: [] });
    expect((await store().history(token, source)).kind).toBe("denied");
  },
);
it("fresh recovery is scoped to current admin and returns only an actual retained receipt", async () => {
  expect((await store().recover(token, operation)).kind).toBe("absent");
  expect(mocks.actors).toHaveBeenLastCalledWith(context, []);
  mocks.candidates.mockResolvedValue([candidate]);
  expect(await store().recover(token, operation)).toEqual({
    kind: "ready",
    row: publicRow,
    deadline: 1000,
  });
  expect(mocks.actors).toHaveBeenLastCalledWith(context, [reviewer, "owner"]);
  expect(mocks.query).not.toHaveBeenCalled();
});
it("exact revoke records one change, and a second/removed observation is harmless", async () => {
  expect((await store().revoke(token, source, operation)).kind).toBe("denied");
  mocks.candidates.mockResolvedValue([candidate]);
  expect((await store().revoke(token, source, operation)).kind).toBe("revoked");
  expect(mocks.locks).toHaveBeenLastCalledWith(context, [candidate], true);
  expect(mocks.query.mock.calls[0]![0]).toMatch(
    /^UPDATE reviewer_evidence_grants/,
  );
  expect(mocks.query.mock.calls[1]![1]).toEqual([
    "admin",
    reviewer,
    "workspace",
    operation,
  ]);
  mocks.query.mockClear();
  mocks.project.mockResolvedValue({
    ...publicRow,
    canRevoke: false,
    state: "removed",
  });
  expect((await store().revoke(token, source, operation)).kind).toBe(
    "unchanged",
  );
  expect(mocks.query).not.toHaveBeenCalled();
});
