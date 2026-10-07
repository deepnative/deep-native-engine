import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import type { SampleTransaction } from "../../src/sample-feedback-lifetime.ts";
const runtime = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../src/sample-feedback-lifetime.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/sample-feedback-lifetime.ts")
    >();
  return { ...actual, sampleFeedbackTransaction: runtime.execute };
});
import { SampleFeedbackFailure } from "../../src/sample-feedback-lifetime.ts";
import {
  reviewActors,
  reviewWorkspace,
  reviewExecute,
  type WorkflowReviewContext,
} from "../../src/workflow-review-transaction.ts";
const token = "a".repeat(64),
  actorId = "b-actor",
  expires = new Date("2026-10-07T10:00:00Z");
const pool = {} as Pool;
function context(rows: unknown[][] = []) {
  const query = vi
    .fn()
    .mockImplementation(async () => ({ rows: rows.shift() ?? [] }));
  const tx = {
    query,
    observe: vi.fn().mockResolvedValue(undefined),
    deadline: () => performance.now() + 60000,
    bounded: async <T>(use: () => Promise<T>) => use(),
  } as unknown as SampleTransaction;
  const c: WorkflowReviewContext = {
    tx,
    actorId,
    credentialHash: "hashed-selected-credential",
    expires: [expires],
  };
  return { c, query, tx };
}
beforeEach(() => {
  runtime.execute.mockReset();
});
it.each(["member", "moderator", "platform_admin"] as const)(
  "WFREV-05 current %s authority rechecks selected actor and locks the full deduplicated ordered set",
  async (role) => {
    const other = { id: "a-other", kind: "member", expires, revoked: null },
      actor = {
        id: actorId,
        kind: role === "member" ? "member" : "staff",
        expires,
        revoked: null,
      };
    const f = context([
      [other],
      [actor],
      role === "member" ? [] : [{ id: actorId, role }],
    ]);
    const result = await reviewActors(f.c, [actorId, other.id, other.id], role);
    expect([...result.principals.keys()]).toEqual([other.id, actorId]);
    expect(f.query.mock.calls[0]![1]).toEqual([other.id, null]);
    expect(f.query.mock.calls[1]![1]).toEqual([actorId, f.c.credentialHash]);
    expect(f.query.mock.calls[2]![1]).toEqual([[other.id, actorId]]);
    expect(f.tx.observe).toHaveBeenCalledWith([expires, expires]);
  },
);
it.each(["missing", "revoked", "wrong-kind", "wrong-profile"] as const)(
  "WFREV-03/05 selected actor %s denies before protected use",
  async (defect) => {
    const actor = {
      id: actorId,
      kind: defect === "wrong-kind" ? "member" : "staff",
      expires,
      revoked: defect === "revoked" ? expires : null,
    };
    const f = context([
      defect === "missing" ? [] : [actor],
      [{ id: actorId, role: "operator" }],
    ]);
    await expect(reviewActors(f.c, [], "moderator")).rejects.toMatchObject({
      kind: "denied",
    });
    expect(f.tx.observe).not.toHaveBeenCalled();
  },
);
it("WFREV-05 a missing related principal cannot fabricate authority while discovering actors", async () => {
  const f = context([
    [],
    [{ id: actorId, kind: "member", expires, revoked: null }],
    [],
  ]);
  const result = await reviewActors(f.c, ["a-other"], "member");
  expect(result.principals.has("a-other")).toBe(false);
});
it("WFREV-07 workspace access requires the current owned nondeleting workspace", async () => {
  const present = context([[{ id: "owned-workspace" }]]);
  expect(await reviewWorkspace(present.c, "owner")).toBe("owned-workspace");
  const absent = context([[]]);
  await expect(reviewWorkspace(absent.c, "owner")).rejects.toMatchObject({
    kind: "denied",
  });
});
it("WFREV-05 invalid selected credentials never acquire a transaction", async () => {
  const use = vi.fn();
  expect(await reviewExecute(pool, "invalid", false, use)).toEqual({
    kind: "denied",
  });
  expect(runtime.execute).not.toHaveBeenCalled();
  expect(use).not.toHaveBeenCalled();
});
it("WFREV-05 identity discovery alone does not bypass callback authority and finite database lifetime", async () => {
  const f = context([[{ id: actorId, expires }], [{ remaining: "5000" }]]);
  runtime.execute.mockImplementation(async (_pool, _write, use) => use(f.tx));
  const use = vi.fn(async (c: WorkflowReviewContext) => {
    expect(c.actorId).toBe(actorId);
    expect(c.credentialHash).not.toBe(token);
    return { kind: "ready" as const, visible: "scoped outcome" };
  });
  const entered = performance.now();
  const result = await reviewExecute(pool, token, true, use);
  expect(result).toMatchObject({ kind: "ready", visible: "scoped outcome" });
  if (!("deadline" in result)) throw Error("Finite handback required");
  expect(result.deadline).toBeGreaterThan(entered);
  expect(result.deadline).toBeLessThanOrEqual(performance.now() + 5000);
  expect(runtime.execute).toHaveBeenCalledWith(
    pool,
    true,
    expect.any(Function),
  );
  expect(f.tx.observe).toHaveBeenCalledTimes(2);
});
it("WFREV-05 missing discovered identity denies before callback", async () => {
  const f = context([[]]);
  runtime.execute.mockImplementation(async (_pool, _write, use) => use(f.tx));
  const use = vi.fn();
  expect(await reviewExecute(pool, token, false, use)).toEqual({
    kind: "denied",
  });
  expect(use).not.toHaveBeenCalled();
});
it.each([
  undefined,
  { remaining: 7 },
  { remaining: "" },
  { remaining: " " },
  { remaining: "NaN" },
  { remaining: "Infinity" },
])(
  "WFREV-05 unavailable database lifetime %j withholds handback",
  async (remaining) => {
    const f = context([
      [{ id: actorId, expires }],
      remaining ? [remaining] : [],
    ]);
    runtime.execute.mockImplementation(async (_pool, _write, use) => use(f.tx));
    expect(
      await reviewExecute(pool, token, false, async () => ({ kind: "ready" })),
    ).toEqual({ kind: "unavailable" });
  },
);
it("WFREV-05 nonpositive database lifetime denies without a protected outcome", async () => {
  const f = context([[{ id: actorId, expires }], [{ remaining: "-1" }]]);
  runtime.execute.mockImplementation(async (_pool, _write, use) => use(f.tx));
  expect(
    await reviewExecute(pool, token, false, async () => ({ kind: "ready" })),
  ).toEqual({ kind: "denied" });
});
it.each([
  new SampleFeedbackFailure("denied"),
  new SampleFeedbackFailure("unavailable"),
  new Error("Invented failed authority read"),
])(
  "WFREV-05 transaction failure %s is normalized without redispatch",
  async (error) => {
    runtime.execute.mockRejectedValue(error);
    expect(
      await reviewExecute(pool, token, true, async () => ({ kind: "ready" })),
    ).toEqual({
      kind: error instanceof SampleFeedbackFailure ? error.kind : "unavailable",
    });
    expect(runtime.execute).toHaveBeenCalledTimes(1);
  },
);
