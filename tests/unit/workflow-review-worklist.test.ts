import type { Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import type { WorkflowReviewContext } from "../../src/workflow-review-transaction.ts";
const f = vi.hoisted(() => ({
  execute: vi.fn(),
  actors: vi.fn(),
  bundle: vi.fn(),
}));
vi.mock("../../src/workflow-review-transaction.ts", async (original) => ({
  ...(await original<
    typeof import("../../src/workflow-review-transaction.ts")
  >()),
  reviewExecute: f.execute,
  reviewActors: f.actors,
}));
vi.mock("../../src/workflow-registry.ts", () => ({ workflowBundle: f.bundle }));
import { workflowReviewWorklist } from "../../src/workflow-review-worklist.ts";
import { workflowReviewCursor } from "../../src/workflow-review-cursor.ts";
const secret = "invented-worklist-secret",
  actorId = "11111111-1111-4111-8111-111111111111",
  id = "22222222-2222-4222-8222-222222222222";
const position = "2026-10-07T09:00:00.123456Z",
  expires = new Date("2026-10-07T10:00:00Z"),
  starts = new Date("2026-10-07T09:00:00Z");
const candidate = {
  id,
  requestId: id,
  memberId: "member",
  moderatorId: actorId,
  administratorId: "administrator",
  instanceId: id,
  revision: 1,
  workflowId: "WF-001",
  workflowVersion: 1,
  workspaceId: "workspace-b",
  createdAt: position,
};
const list = () => workflowReviewWorklist({} as Pool, secret);
function fixture(candidates: unknown[], current: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  query.mockResolvedValueOnce({ rows: candidates });
  for (let n = 0; n < 4; n++) query.mockResolvedValueOnce({ rows: [] });
  query.mockResolvedValueOnce({ rows: current });
  const observe = vi.fn().mockResolvedValue(undefined),
    ctx = {
      actorId,
      expires: [expires],
      tx: {
        query,
        observe,
        bounded: async <T>(use: () => Promise<T>) => use(),
      },
    } as unknown as WorkflowReviewContext;
  f.execute.mockImplementation(async (_pool, _token, _writing, use) => ({
    ...(await use(ctx)),
    deadline: performance.now() + 60000,
  }));
  return { query, ctx, observe };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.bundle.mockResolvedValue({ version: 1 });
});
it("WFREV-03/07 malformed worklist cursor denies without acquiring authority", async () => {
  expect(await list()("token", "forged")).toEqual({ kind: "invalid" });
  expect(f.execute).not.toHaveBeenCalled();
});
it("WFREV-03/07 another moderator continuation denies before metadata discovery", async () => {
  fixture([], []);
  const after = workflowReviewCursor(secret, "worklist").sign({
    actorId: id,
    id,
    createdAt: position,
  });
  expect(await list()("token", after)).toMatchObject({ kind: "denied" });
  expect(f.actors).not.toHaveBeenCalled();
});
it("WFREV-03 empty current worklist does not invent assignments", async () => {
  const fxt = fixture([], []);
  expect(await list()("token")).toMatchObject({
    kind: "ready",
    entries: [],
    next: null,
  });
  expect(f.actors).toHaveBeenCalledWith(fxt.ctx, [], "moderator");
});
it("WFREV-03 exact current assignment metadata uses earliest observed authority and no private text", async () => {
  const authorityExpires = new Date("2026-10-07T09:30:00Z"),
    fxt = fixture(
      [candidate],
      [{ ...candidate, starts, expires, authorityExpires }],
    );
  const result = await list()("token");
  expect(result).toMatchObject({
    kind: "ready",
    entries: [
      {
        grantId: id,
        workflowId: "WF-001",
        workflowVersion: 1,
        revision: 1,
        startsAt: starts.toISOString(),
        expiresAt: expires.toISOString(),
      },
    ],
    next: null,
  });
  expect(fxt.observe).toHaveBeenCalledWith([expires, authorityExpires]);
  expect(JSON.stringify(result)).not.toContain("administrator");
  expect(JSON.stringify(result)).not.toContain("member");
});
it.each([
  "changed-revision",
  "unknown-grant",
  "missing-bundle",
  "stale-workflow",
])(
  "WFREV-03 discovery becoming %s never projects an assignment",
  async (change) => {
    if (change === "missing-bundle") f.bundle.mockResolvedValue(null);
    if (change === "stale-workflow") f.bundle.mockResolvedValue({ version: 2 });
    fixture(
      [candidate],
      [
        {
          ...candidate,
          starts,
          expires,
          authorityExpires: expires,
          ...(change === "changed-revision"
            ? { revision: 2 }
            : change === "unknown-grant"
              ? { id: actorId }
              : {}),
        },
      ],
    );
    expect(await list()("token")).toMatchObject({ kind: "ready", entries: [] });
  },
);
it("WFREV-07 21-row lookahead returns 20 exact entries and a purpose-bound microsecond continuation", async () => {
  const candidates = Array.from({ length: 21 }, (_, n) => ({
    ...candidate,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    workspaceId: n % 2 ? "workspace-a" : "workspace-b",
  }));
  const fxt = fixture(
    candidates,
    candidates
      .slice(0, 20)
      .map((c) => ({ ...c, starts, expires, authorityExpires: expires })),
  );
  const codec = workflowReviewCursor(secret, "worklist"),
    after = codec.sign({ actorId, id, createdAt: position });
  const result = await list()("token", after);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw Error("Worklist required");
  expect(result.entries).toHaveLength(20);
  expect(codec.read(result.next)).toEqual({
    actorId,
    id: candidates[19]!.id,
    createdAt: position,
  });
  expect(fxt.query.mock.calls[0]![1]).toEqual([actorId, position, id]);
  expect(fxt.query.mock.calls[1]![1]).toEqual([["workspace-a", "workspace-b"]]);
});
