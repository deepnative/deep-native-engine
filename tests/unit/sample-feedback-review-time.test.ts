import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { ObjectStorage } from "../../src/evidence.ts";
import {
  sampleFeedbackStore,
  type SampleFeedbackRecord,
} from "../../src/sample-feedback.ts";
const id = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64);
function fixture(staff = true) {
  const source = Buffer.from("Invented source");
  const expiry = new Date(Date.now() + 60000);
  const state = {
    identity: {
      id,
      kind: staff ? "staff" : "member",
      role: staff ? "reviewer" : null,
      expires: expiry,
    } as Record<string, unknown> | undefined,
    workspace: { id } as { id: string } | undefined,
    evidence: {
      owner: id,
      consent: true,
      state: "clean",
      name: "Sample",
      media: "text/plain",
      key: "private-source",
      bytes: source.length,
      digest: createHash("sha256").update(source).digest("hex"),
      revision: 1,
    },
    submission: { id, status: "queued" } as
      { id: string; status: string } | undefined,
    assignment: { id, expires: expiry } as
      { id: string; expires: Date } | undefined,
    grant: { id, expires: expiry } as { id: string; expires: Date } | undefined,
    records: [] as SampleFeedbackRecord[],
    replay: undefined as { digest: string; revision: number } | undefined,
    throwQuery: false,
    profile: true,
    timeGrant: true,
    currentAllocation: false,
    held: false,
  };
  const calls: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (state.throwQuery) throw Error("private database diagnostic");
    let rows: unknown[] = [];
    if (sql.includes("WITH instant"))
      rows = [{ remaining: "60000", valid: true, observed: new Date() }];
    else if (sql.includes("FROM staff_profiles WHERE"))
      rows = state.profile ? [{}] : [];
    else if (
      sql.includes("SELECT g.expires_at AS expires FROM review_time_grants")
    )
      rows = state.timeGrant ? [{ expires: expiry }] : [];
    else if (sql.includes('g.id AS "grantId" FROM review_time_allocations'))
      rows = state.currentAllocation ? [{ allocationId: id, grantId: id }] : [];
    else if (sql.includes("SELECT 1 FROM review_time_allocations"))
      rows = state.held ? [{}] : [];
    else if (sql.includes("FROM principals p"))
      rows = state.identity ? [state.identity] : [];
    else if (sql.includes("SELECT w.id FROM workspaces"))
      rows = state.workspace ? [state.workspace] : [];
    else if (sql.includes("original_name AS name")) rows = [state.evidence];
    else if (sql.includes("SELECT id,status FROM evidence_review_submissions"))
      rows = state.submission ? [state.submission] : [];
    else if (sql.includes("FROM assignment_grants a"))
      rows = state.assignment ? [state.assignment] : [];
    else if (
      sql.includes(
        "SELECT id,expires_at AS expires FROM reviewer_evidence_grants",
      )
    )
      rows = state.grant ? [state.grant] : [];
    else if (sql.includes("FROM private_sample_feedback_draft_operations"))
      rows = state.replay ? [state.replay] : [];
    else if (
      sql.includes("FROM private_sample_feedback\n") ||
      sql.includes("FROM private_sample_feedback WHERE")
    )
      rows = state.records;
    return { rows };
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query, release }) as unknown as PoolClient),
  };
  const objects = { get: vi.fn(async () => source) };
  return {
    state,
    calls,
    pool,
    objects,
    release,
    store: sampleFeedbackStore(
      pool as unknown as Pool,
      objects as unknown as ObjectStorage,
      { reviewTimeWrites: true, mode: "test" },
    ),
  };
}
function record(f: ReturnType<typeof fixture>): SampleFeedbackRecord {
  return {
    id,
    submissionId: id,
    authorId: id,
    sourceSha256: f.state.evidence.digest,
    sourceRevision: 1,
    criteria: [
      {
        label: "Clarity",
        comment: "Explain the example",
        quote: "Invented",
        start: 0,
        end: 8,
      },
    ],
    preparationMinutes: null,
    reviewMinutes: null,
    revision: 1,
    draftOperationId: id,
    publicationOperationId: null,
    publishedAt: null,
    clarification: null,
    clarificationOperationId: null,
    clarifiedAt: null,
    answer: null,
    answerOperationId: null,
    answeredAt: null,
  };
}

const time = vi.hoisted(() => ({
  begin: vi.fn(),
  record: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock("../../src/review-time.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/review-time.ts")>();
  return {
    ...actual,
    beginReviewTime: time.begin,
    recordReviewTime: time.record,
    reviewTimeReceipt: time.receipt,
  };
});
const receipt = {
  allocationId: id,
  state: "begun",
  ceiling: 20,
  held: 20,
  consumed: 0,
  released: 0,
  reviewMinutes: 0,
  preparationMinutes: 0,
  sourceAvailable: true,
};
const intervals = {
  reviewStart: new Date("2026-10-04T12:00:00Z"),
  reviewEnd: new Date("2026-10-04T12:10:00Z"),
  preparationStart: null,
  preparationEnd: null,
};
const allocated = { allocationId: id, grantId: id, intervals };
beforeEach(() => {
  vi.clearAllMocks();
  time.begin.mockResolvedValue({ kind: "applied", receipt });
  time.receipt.mockResolvedValue(receipt);
  time.record.mockImplementation(async (...args: unknown[]) => {
    await (args[7] as () => Promise<void>)();
    return { kind: "applied", receipt };
  });
});
it("begins only after exact sample and time grants with actor locking before source access", async () => {
  const f = fixture();
  expect((await f.store.beginReview(token, id, id, id, id)).kind).toBe(
    "applied",
  );
  const sql = f.calls.map((c) => c.sql);
  expect(
    sql.findIndex((s) => s.includes("pg_advisory_xact_lock")),
  ).toBeLessThan(sql.findIndex((s) => s.includes("SELECT w.id")));
  expect(time.begin).toHaveBeenCalledTimes(1);
});
it.each(["profile", "timeGrant"] as const)(
  "denies begin without %s",
  async (field) => {
    const f = fixture();
    f.state[field] = false;
    expect((await f.store.beginReview(token, id, id, id, id)).kind).toBe(
      "denied",
    );
    expect(time.begin).not.toHaveBeenCalled();
  },
);
it("passes reviewed-source resolution to the begin policy and refuses malformed identifiers", async () => {
  const f = fixture();
  f.state.submission!.status = "reviewed";
  await f.store.beginReview(token, id, id, id, id);
  expect(time.begin.mock.calls[0]![3].resolvedAt).toEqual(new Date(0));
  expect(await f.store.beginReview(token, id, "bad", id, id)).toEqual({
    kind: "invalid",
  });
  const paused = sampleFeedbackStore(
    f.pool as unknown as Pool,
    f.objects as unknown as ObjectStorage,
  );
  expect(await paused.beginReview(token, id, id, id, id)).toEqual({
    kind: "unavailable",
  });
});
it("shows receipt quantities only with a current allocation-specific grant", async () => {
  const f = fixture();
  f.state.currentAllocation = true;
  expect(await f.store.reviewer(token, id)).toMatchObject({
    kind: "ready",
    reviewAllocation: { receipt, grantId: id, writesEnabled: true },
  });
  f.state.timeGrant = false;
  expect((await f.store.reviewer(token, id)).kind).toBe("denied");
});
it.each([false, true])(
  "publishes and settles a saved draft with optional preparation=%s",
  async (prep) => {
    const f = fixture();
    f.state.records = [record(f)];
    const input = prep
      ? {
          ...allocated,
          intervals: {
            ...intervals,
            preparationStart: new Date("2026-10-04T11:55:00Z"),
            preparationEnd: intervals.reviewStart,
          },
        }
      : allocated;
    expect(await f.store.publish(token, id, 1, id, input)).toEqual({
      kind: "saved",
      id,
      revision: 1,
    });
    expect(time.record).toHaveBeenCalledTimes(1);
    expect(
      f.calls.some((c) => c.sql.includes("SET publication_operation_id")),
    ).toBe(true);
    expect(time.record.mock.calls[0]![4]).not.toBe(input.intervals);
  },
);
it.each(["conflict", "denied", "insufficient"])(
  "withholds publication on settlement %s",
  async (kind) => {
    const f = fixture();
    f.state.records = [record(f)];
    time.record.mockResolvedValue({ kind });
    expect((await f.store.publish(token, id, 1, id, allocated)).kind).toBe(
      kind === "conflict" ? "conflict" : "denied",
    );
    expect(
      f.calls.some((c) => c.sql.includes("SET publication_operation_id")),
    ).toBe(false);
  },
);
it("requires the saved revision and independent time grant, blocking old unbilled publication while held", async () => {
  const f = fixture();
  f.state.records = [record(f)];
  f.state.timeGrant = false;
  expect((await f.store.publish(token, id, 1, id, allocated)).kind).toBe(
    "denied",
  );
  f.state.held = true;
  expect((await f.store.publish(token, id, 1, id)).kind).toBe("conflict");
  expect(time.record).not.toHaveBeenCalled();
});
it.each([
  { ...allocated, allocationId: "bad" },
  { ...allocated, grantId: "bad" },
  {
    ...allocated,
    intervals: { ...intervals, reviewEnd: intervals.reviewStart },
  },
])(
  "rejects malformed allocated publication before database access",
  async (input) => {
    const f = fixture();
    expect((await f.store.publish(token, id, 1, id, input)).kind).toBe(
      "invalid",
    );
    expect(f.pool.connect).not.toHaveBeenCalled();
  },
);
it("keeps exact published replay immutable when the settlement invokes publication again", async () => {
  const f = fixture();
  f.state.records = [
    { ...record(f), publishedAt: new Date(), publicationOperationId: id },
  ];
  expect((await f.store.publish(token, id, 1, id, allocated)).kind).toBe(
    "saved",
  );
  expect(
    f.calls.some((c) => c.sql.includes("SET publication_operation_id")),
  ).toBe(false);
  f.state.records[0]!.publicationOperationId = "other";
  expect((await f.store.publish(token, id, 1, id, allocated)).kind).toBe(
    "conflict",
  );
});
