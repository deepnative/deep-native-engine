import type { PoolClient } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  reserve: vi.fn(),
  consume: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../src/ledger.ts", () => ({
  reviewLedgerOnConnection: () => boundary,
}));
import {
  allocateReviewTime,
  beginReviewTime,
  cancelReviewTime,
  recordReviewTime as recordActual,
  reviewIntervalMinutes,
  reviewTimeReceipt,
  type ReviewTimeIntervals,
} from "../../src/review-time.ts";
const memberId = "member",
  actorId = "operator",
  allocationId = "allocation",
  key = "original-key";
const scope = { sourceKey: "request", allocationId, grantId: "time-grant" };
const request = {
  sourceKey: scope.sourceKey,
  memberId,
  workspaceId: "workspace",
  evidenceId: "evidence",
  sourceRevision: 1,
  withdrawnAt: null,
  resolvedAt: null,
};
const date = new Date("2026-10-03T01:00:00Z"),
  future = new Date("2100-01-01");
const receipt = {
  allocationId,
  ceiling: 20,
  state: "completed",
  held: 0,
  consumed: 15,
  released: 5,
  reviewMinutes: 10,
  preparationMinutes: 5,
};
const segments: ReviewTimeIntervals = {
  reviewStart: date,
  reviewEnd: new Date(+date + 600000),
  preparationStart: new Date(+date + 600000),
  preparationEnd: new Date(+date + 900000),
};
const publication = {
  feedbackId: "feedback",
  draftRevision: 1,
  operationId: "publish-key",
};
const publish = vi.fn<() => Promise<void>>();
function recordReviewTime(
  ...args: Parameters<typeof recordActual> extends [
    ...infer Head,
    unknown,
    unknown,
  ]
    ? Head
    : never
) {
  return recordActual(...args, publication, publish);
}
const saved = { ...segments, key, ...publication };
const allocation = {
  state: "begun",
  actorId,
  memberId,
  grantId: "budget",
  beginGrantId: scope.grantId,
  beginKey: null,
  ceiling: 20,
};
type Options = {
  prior?: object;
  unresolved?: boolean;
  grant?: boolean;
  eligible?: boolean;
  missing?: boolean;
  state?: string;
  actor?: string | null;
  beginGrant?: string | null;
  beginKey?: string;
  ceiling?: number;
  saved?: object;
  window?: boolean;
  overlap?: boolean;
  units?: number;
  withinBudget?: boolean;
  receiptMissing?: boolean;
  flagsMissing?: boolean;
};
function database(o: Options = {}) {
  const query = vi.fn(async (sql: string) => {
    const rows = sql.includes("SELECT id,ceiling FROM review_time_allocations")
      ? o.prior
        ? [o.prior]
        : []
      : sql.includes("state IN ('allocated'")
        ? o.unresolved
          ? [{ id: allocationId }]
          : []
        : sql.includes("ORDER BY expires_at,id LIMIT 1")
          ? o.grant === false
            ? []
            : [{ id: "budget", expiresAt: future }]
          : sql.startsWith("SELECT id FROM synthetic_entitlement_grants")
            ? o.eligible === false
              ? []
              : [{ id: "budget" }]
            : sql.includes("SELECT state,")
              ? o.missing
                ? []
                : [
                    {
                      ...allocation,
                      state: o.state ?? allocation.state,
                      actorId: o.actor === undefined ? actorId : o.actor,
                      beginGrantId:
                        o.beginGrant === undefined
                          ? scope.grantId
                          : o.beginGrant,
                      beginKey: o.beginKey ?? null,
                      ceiling: o.ceiling ?? 20,
                    },
                  ]
              : sql.startsWith("SELECT expires_at")
                ? o.grant === false
                  ? []
                  : [{ expiresAt: future }]
                : sql.startsWith("SELECT 1 WHERE clock_timestamp()")
                  ? o.withinBudget === false
                    ? []
                    : [{}]
                  : sql.startsWith("SELECT clock_timestamp()+")
                    ? [{ deadline: future }]
                    : sql.startsWith("SELECT idempotency_key")
                      ? o.saved
                        ? [o.saved]
                        : []
                      : sql.startsWith("SELECT $1::timestamptz")
                        ? [{ valid: o.window !== false }]
                        : sql.startsWith("SELECT EXISTS")
                          ? [{ conflict: o.overlap === true }]
                          : sql.includes("SELECT ordinal,reservation_id")
                            ? Array.from(
                                { length: o.units ?? o.ceiling ?? 20 },
                                (_, n) => ({
                                  ordinal: n + 1,
                                  reservationId: `unit-${n + 1}`,
                                }),
                              )
                            : sql.includes('AS "canBegin"')
                              ? o.flagsMissing
                                ? []
                                : [{ canBegin: false, canRecord: true }]
                              : sql.includes('SELECT a.id AS "allocationId"')
                                ? o.receiptMissing
                                  ? []
                                  : [receipt]
                                : [];
    return { rows, rowCount: rows.length };
  });
  return { query, client: { query } as unknown as PoolClient };
}
beforeEach(() => {
  vi.resetAllMocks();
  boundary.reserve.mockResolvedValue("reservation");
});
it("accepts one through 120 whole review minutes and optional adjacent preparation on either side", () => {
  expect(reviewIntervalMinutes(segments)).toEqual({
    review: 10,
    preparation: 5,
  });
  expect(
    reviewIntervalMinutes({
      ...segments,
      preparationStart: new Date(+date - 300000),
      preparationEnd: date,
    }),
  ).toEqual({ review: 10, preparation: 5 });
  for (const minutes of [1, 120])
    expect(
      reviewIntervalMinutes({
        reviewStart: date,
        reviewEnd: new Date(+date + minutes * 60000),
        preparationStart: null,
        preparationEnd: null,
      }),
    ).toEqual({ review: minutes, preparation: 0 });
});
it.each([
  { reviewStart: new Date(NaN) },
  { reviewEnd: new Date(NaN) },
  { reviewStart: "invalid" },
  { reviewEnd: date },
  { reviewEnd: new Date(+date - 60000) },
  { reviewEnd: new Date(+date + 1) },
  { reviewEnd: new Date(+date + 121 * 60000) },
  { preparationStart: null },
  { preparationEnd: null },
  { preparationStart: new Date(NaN) },
  { preparationEnd: new Date(NaN) },
  { preparationStart: segments.preparationEnd },
  { preparationEnd: new Date(+segments.preparationStart! - 60000) },
  { preparationEnd: new Date(+segments.preparationStart! + 1) },
  { preparationEnd: new Date(+segments.preparationStart! + 111 * 60000) },
  {
    preparationStart: new Date(+date + 300000),
    preparationEnd: segments.reviewEnd,
  },
])(
  "rejects invalid, fractional, empty, excessive or overlapping intervals: %j",
  (change) => {
    expect(
      reviewIntervalMinutes({
        ...segments,
        ...change,
      } as ReviewTimeIntervals),
    ).toBeNull();
  },
);
it("returns safe saved facts and fails closed when the allocation receipt disappears", async () => {
  expect(await reviewTimeReceipt(database().client, allocationId)).toEqual(
    receipt,
  );
  await expect(
    reviewTimeReceipt(database({ receiptMissing: true }).client, allocationId),
  ).rejects.toThrow("unavailable");
});
it("replays the original allocation before selecting a fresh allowance, but rejects changing its ceiling", async () => {
  const db = database({ prior: { id: allocationId, ceiling: 20 } });
  expect(
    await allocateReviewTime(
      db.client,
      { ...request, withdrawnAt: date },
      key,
      20,
      [],
    ),
  ).toEqual({ kind: "replayed", receipt });
  expect(await allocateReviewTime(db.client, request, key, 19, [])).toEqual({
    kind: "conflict",
  });
  expect(boundary.reserve).not.toHaveBeenCalled();
});
it.each([
  [{ withdrawnAt: date }, {}, "withdrawn"],
  [{ resolvedAt: date }, {}, "conflict"],
  [{}, { unresolved: true }, "conflict"],
  [{}, { grant: false }, "insufficient"],
  [{}, { eligible: false }, "insufficient"],
] as const)(
  "refuses allocating ineligible requests or unavailable whole ceilings without a reserve: %j",
  async (change, options, kind) => {
    expect(
      await allocateReviewTime(
        database(options).client,
        { ...request, ...change },
        key,
        20,
        [],
      ),
    ).toEqual({ kind });
    expect(boundary.reserve).not.toHaveBeenCalled();
  },
);
it("holds exactly the confirmed ceiling with one-minute ledger operations on the caller transaction", async () => {
  const db = database(),
    deadlines: Date[] = [];
  expect(
    await allocateReviewTime(db.client, request, key, 20, deadlines),
  ).toEqual({ kind: "applied", receipt });
  expect(boundary.reserve).toHaveBeenCalledTimes(20);
  for (const [member, grant, quantity, operationKey] of boundary.reserve.mock
    .calls) {
    expect([member, grant, quantity]).toEqual([memberId, "budget", 1]);
    expect(operationKey).toMatch(/:unit:\d+:reserve$/);
  }
  expect(deadlines).toEqual([future, future]);
  expect(
    db.query.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)),
  ).toBe(false);
});
it("propagates reserve failure and aggregate-budget exhaustion for caller rollback, without pretending allocation success", async () => {
  boundary.reserve.mockRejectedValueOnce(Error("Ledger unavailable"));
  await expect(
    allocateReviewTime(database().client, request, key, 20, []),
  ).rejects.toThrow("Ledger unavailable");
  await expect(
    allocateReviewTime(
      database({ withinBudget: false }).client,
      request,
      key,
      20,
      [],
    ),
  ).rejects.toThrow("budget exceeded");
});
it("replays begin only for the original actor, exact grant and key before budget selection", async () => {
  expect(
    await beginReviewTime(
      database({ beginKey: key }).client,
      actorId,
      scope,
      { withdrawnAt: date, resolvedAt: null },
      key,
      [],
    ),
  ).toEqual({ kind: "replayed", receipt });
  for (const options of [{ actor: "other" }, { beginGrant: "other" }])
    expect(
      await beginReviewTime(
        database({ beginKey: key, ...options }).client,
        actorId,
        scope,
        request,
        key,
        [],
      ),
    ).toEqual({ kind: "conflict" });
});
it.each([
  [{}, { missing: true }, "denied"],
  [{ withdrawnAt: date }, {}, "withdrawn"],
  [{ resolvedAt: date }, {}, "conflict"],
  [{}, { state: "completed" }, "conflict"],
  [{}, { state: "allocated", grant: false }, "insufficient"],
  [{}, { state: "allocated", withinBudget: false }, "insufficient"],
] as const)(
  "rejects begin without current request/allocation/budget eligibility: %j",
  async (change, options, kind) => {
    expect(
      await beginReviewTime(
        database(options).client,
        actorId,
        scope,
        { ...request, ...change },
        key,
        [],
      ),
    ).toEqual({ kind });
  },
);
it("records durable begin metadata without consuming or releasing minutes", async () => {
  const deadlines: Date[] = [],
    db = database({ state: "allocated" });
  expect(
    await beginReviewTime(db.client, actorId, scope, request, key, deadlines),
  ).toEqual({ kind: "applied", receipt });
  expect(deadlines).toEqual([future]);
  expect(boundary.consume).not.toHaveBeenCalled();
  expect(boundary.release).not.toHaveBeenCalled();
});
it("replays an exact saved entry before considering the now-stale window, but conflicts on every changed component", async () => {
  const db = database({ saved, window: false });
  expect(
    await recordReviewTime(db.client, actorId, scope, key, segments, []),
  ).toEqual({ kind: "replayed", receipt });
  for (const change of [
    { key: "changed" },
    { feedbackId: "other" },
    { draftRevision: 2 },
    { operationId: "other" },
    { reviewStart: new Date(+date - 60000) },
    { reviewEnd: new Date(+segments.reviewEnd + 60000) },
    { preparationStart: new Date(+segments.preparationStart! + 60000) },
    { preparationEnd: new Date(+segments.preparationEnd! + 60000) },
  ]) {
    expect(
      await recordReviewTime(
        database({ saved: { ...saved, ...change } }).client,
        actorId,
        scope,
        key,
        segments,
        [],
      ),
    ).toEqual({ kind: "conflict" });
  }
  const noPrep = { ...segments, preparationStart: null, preparationEnd: null };
  expect(
    await recordReviewTime(
      database({ saved: { ...noPrep, key, ...publication } }).client,
      actorId,
      scope,
      key,
      noPrep,
      [],
    ),
  ).toEqual({ kind: "replayed", receipt });
  expect(boundary.consume).not.toHaveBeenCalled();
  expect(boundary.release).not.toHaveBeenCalled();
});
it.each([
  [{ missing: true }, "denied"],
  [{ actor: "other" }, "denied"],
  [{ beginGrant: "other" }, "denied"],
  [{ state: "allocated" }, "conflict"],
  [{ ceiling: 14 }, "conflict"],
  [{ window: false }, "denied"],
  [{ overlap: true }, "conflict"],
] as const)(
  "refuses recording missing, foreign, unbegun, excessive, stale or overlapping work: %j",
  async (options, kind) => {
    expect(
      await recordReviewTime(
        database(options).client,
        actorId,
        scope,
        key,
        segments,
        [],
      ),
    ).toEqual({ kind });
    expect(boundary.consume).not.toHaveBeenCalled();
    expect(boundary.release).not.toHaveBeenCalled();
  },
);
it("denies malformed recording before accessing stored rows", async () => {
  const db = database();
  expect(
    await recordReviewTime(
      db.client,
      actorId,
      scope,
      key,
      { ...segments, reviewEnd: date },
      [],
    ),
  ).toEqual({ kind: "denied" });
  expect(db.query).not.toHaveBeenCalled();
});
it.each([true, false])(
  "settles the exact recorded total with preparation=%s and releases only remaining units",
  async (prep) => {
    const input = prep
        ? segments
        : { ...segments, preparationStart: null, preparationEnd: null },
      deadlines: Date[] = [];
    expect(
      await recordReviewTime(
        database().client,
        actorId,
        scope,
        key,
        input,
        deadlines,
      ),
    ).toEqual({ kind: "applied", receipt });
    expect(boundary.consume).toHaveBeenCalledTimes(prep ? 15 : 10);
    expect(boundary.release).toHaveBeenCalledTimes(prep ? 5 : 10);
    expect(
      new Set(
        [...boundary.consume.mock.calls, ...boundary.release.mock.calls].map(
          (call) => call[1],
        ),
      ).size,
    ).toBe(20);
    expect(deadlines).toHaveLength(prep ? 3 : 2);
  },
);
it("refuses incomplete allocations and propagates settlement failure or operation budget expiry for atomic rollback", async () => {
  await expect(
    recordReviewTime(
      database({ units: 19 }).client,
      actorId,
      scope,
      key,
      segments,
      [],
    ),
  ).rejects.toThrow("Incomplete");
  await expect(
    recordReviewTime(
      database({ withinBudget: false }).client,
      actorId,
      scope,
      key,
      segments,
      [],
    ),
  ).rejects.toThrow("budget exceeded");
  boundary.consume.mockRejectedValueOnce(Error("Ledger unavailable"));
  await expect(
    recordReviewTime(database().client, actorId, scope, key, segments, []),
  ).rejects.toThrow("Ledger unavailable");
});
it("replays cancellation and denies foreign or begun/unknown cancellation without releasing anything", async () => {
  expect(
    await cancelReviewTime(
      database({ state: "cancelled" }).client,
      scope.sourceKey,
      allocationId,
      memberId,
      [],
    ),
  ).toEqual({ kind: "replayed", receipt });
  expect(
    await cancelReviewTime(
      database({ missing: true }).client,
      scope.sourceKey,
      allocationId,
      memberId,
      [],
    ),
  ).toEqual({ kind: "denied" });
  for (const state of ["begun", "completed", "needs_reconciliation"])
    expect(
      await cancelReviewTime(
        database({ state }).client,
        scope.sourceKey,
        allocationId,
        memberId,
        [],
      ),
    ).toEqual({ kind: "conflict" });
  expect(boundary.release).not.toHaveBeenCalled();
});
it("cancels all known unstarted units exactly once through the shared ledger with no consumption", async () => {
  const db = database({ state: "allocated" }),
    deadlines: Date[] = [];
  expect(
    await cancelReviewTime(
      db.client,
      scope.sourceKey,
      allocationId,
      memberId,
      deadlines,
    ),
  ).toEqual({ kind: "applied", receipt });
  expect(boundary.release).toHaveBeenCalledTimes(20);
  expect(boundary.consume).not.toHaveBeenCalled();
  expect(deadlines).toEqual([future]);
});
it("fails incomplete cancellation and propagates release failure or deadline expiry for caller rollback", async () => {
  await expect(
    cancelReviewTime(
      database({ state: "allocated", units: 19 }).client,
      scope.sourceKey,
      allocationId,
      memberId,
      [],
    ),
  ).rejects.toThrow("Incomplete");
  await expect(
    cancelReviewTime(
      database({ state: "allocated", withinBudget: false }).client,
      scope.sourceKey,
      allocationId,
      memberId,
      [],
    ),
  ).rejects.toThrow("budget exceeded");
  boundary.release.mockRejectedValueOnce(Error("Ledger unavailable"));
  await expect(
    cancelReviewTime(
      database({ state: "allocated" }).client,
      scope.sourceKey,
      allocationId,
      memberId,
      [],
    ),
  ).rejects.toThrow("Ledger unavailable");
});

it("propagates publication failure before marking an allocation complete, requiring caller rollback", async () => {
  const db = database();
  publish.mockRejectedValueOnce(Error("publication failed"));
  await expect(
    recordReviewTime(db.client, actorId, scope, key, segments, []),
  ).rejects.toThrow("publication failed");
  expect(
    db.query.mock.calls.some(([sql]) => sql.includes("SET state='completed'")),
  ).toBe(false);
  expect(publish).toHaveBeenCalledTimes(1);
});
