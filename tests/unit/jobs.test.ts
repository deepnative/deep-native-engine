import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Adapter, AdapterRegistry } from "../../src/adapters.ts";
import {
  enqueueAdapterJob,
  jobStore,
  requestFingerprint,
  runAdapterJob,
  type SafeJobError,
  type AdapterAttempt,
  type AdapterJob,
  type JobStore,
} from "../../src/jobs.ts";

const fingerprint = requestFingerprint({ lesson: 1 });
const baseRow = {
  id: "00000000-0000-4000-8000-000000000001",
  adapter: "ai" as const,
  mode: "test" as const,
  operation: "summarize",
  idempotency_key: "lesson-1",
  request_fingerprint: fingerprint,
  status: "pending" as const,
  attempt_count: 0,
  max_attempts: 3,
  safe_error: null,
  attempt_token: null,
};

function database(...rows: unknown[]) {
  const query = vi.fn();
  for (const row of rows)
    query.mockResolvedValueOnce({ rows: row ? [row] : [] });
  return { query, store: jobStore({ query } as unknown as Pool) };
}

function publicJob(overrides: Partial<AdapterJob> = {}): AdapterJob {
  return {
    id: baseRow.id,
    adapter: "ai",
    mode: "test",
    operation: "summarize",
    requestFingerprint: fingerprint,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    safeError: null,
    retryable: true,
    ...overrides,
  };
}

function registry(execute = vi.fn()): AdapterRegistry {
  return {
    mode: "test",
    adapter: vi.fn(
      (kind, mode): Adapter => ({ kind, mode, execute }) as Adapter,
    ),
  };
}

function runStore(overrides: Partial<JobStore> = {}): JobStore {
  const pending = publicJob();
  const running: AdapterAttempt = {
    ...pending,
    status: "running",
    attempts: 1,
    retryable: false,
    attemptToken: "00000000-0000-4000-8000-000000000002",
  };
  return {
    enqueue: vi.fn().mockResolvedValue(pending),
    find: vi.fn().mockResolvedValue(pending),
    claim: vi.fn().mockResolvedValue(running),
    fail: vi
      .fn()
      .mockResolvedValue(
        publicJob({ status: "failed", attempts: 1, retryable: true }),
      ),
    succeed: vi
      .fn()
      .mockResolvedValue(
        publicJob({ status: "succeeded", attempts: 1, retryable: false }),
      ),
    ...overrides,
  };
}

it("fingerprints equal inputs deterministically and distinguishes changed inputs", () => {
  expect(requestFingerprint({ lesson: 1 })).toBe(fingerprint);
  expect(requestFingerprint({ lesson: 2 })).not.toBe(fingerprint);
  expect(requestFingerprint(undefined)).toMatch(/^[a-f0-9]{64}$/);
});

it("enqueues an idempotent bounded job using normalized parameter values", async () => {
  const db = database(baseRow);
  await expect(
    db.store.enqueue("ai", "test", " summarize ", " lesson-1 ", fingerprint),
  ).resolves.toMatchObject({
    status: "pending",
    retryable: true,
    attempts: 0,
    maxAttempts: 3,
  });
  expect(db.query.mock.calls[0]![1]).toEqual([
    expect.any(String),
    "ai",
    "test",
    "summarize",
    "lesson-1",
    fingerprint,
    3,
  ]);
});

it.each([
  ["adapter", { adapter: "email" }],
  ["mode", { mode: "demo" }],
  ["operation", { operation: "send" }],
  ["fingerprint", { request_fingerprint: "a".repeat(64) }],
  ["attempt bound", { max_attempts: 4 }],
])("rejects idempotency-key reuse with changed %s", async (_label, change) => {
  const db = database(undefined, { ...baseRow, ...change });
  await expect(
    db.store.enqueue("ai", "test", "summarize", "lesson-1", fingerprint),
  ).rejects.toThrow("another request");
});

it("reports an enqueue that unexpectedly returns no row", async () => {
  await expect(
    database(undefined, undefined).store.enqueue(
      "ai",
      "test",
      "summarize",
      "lesson-1",
      fingerprint,
    ),
  ).rejects.toThrow("could not be enqueued");
});

it.each([
  ["", "key", fingerprint, 3, "Job operation"],
  ["x".repeat(81), "key", fingerprint, 3, "Job operation"],
  ["run", "", fingerprint, 3, "Job idempotency key"],
  ["run", "x".repeat(121), fingerprint, 3, "Job idempotency key"],
  ["run", "key", "not-a-digest", 3, "SHA-256"],
  ["run", "key", fingerprint, 0, "integer from 1 to 5"],
  ["run", "key", fingerprint, 1.5, "integer from 1 to 5"],
  ["run", "key", fingerprint, 6, "integer from 1 to 5"],
])(
  "rejects invalid enqueue values",
  async (operation, key, digest, maxAttempts, message) =>
    expect(
      jobStore({} as Pool).enqueue(
        "ai",
        "test",
        operation as string,
        key as string,
        digest as string,
        maxAttempts as number,
      ),
    ).rejects.toThrow(message as string),
);

it("finds jobs, maps retryability and returns undefined for unknown IDs", async () => {
  const db = database(
    { ...baseRow, status: "failed", attempt_count: 1 },
    { ...baseRow, status: "succeeded", attempt_count: 1 },
    undefined,
  );
  expect(await db.store.find(baseRow.id)).toMatchObject({
    status: "failed",
    retryable: true,
  });
  expect(await db.store.find(baseRow.id)).toMatchObject({
    status: "succeeded",
    retryable: false,
  });
  expect(await db.store.find("missing")).toBeUndefined();
});

it("claims one active leased attempt and returns no claim when unavailable", async () => {
  const db = database(
    {
      ...baseRow,
      status: "running",
      attempt_count: 1,
      attempt_token: "00000000-0000-4000-8000-000000000002",
    },
    undefined,
  );
  expect(await db.store.claim(baseRow.id)).toMatchObject({
    status: "running",
    attempts: 1,
    attemptToken: "00000000-0000-4000-8000-000000000002",
  });
  expect(await db.store.claim(baseRow.id)).toBeUndefined();
});

it.each([
  [{ ...baseRow, status: "failed", attempt_token: "token" }, "not active"],
  [{ ...baseRow, status: "running", attempt_token: null }, "not active"],
])("rejects malformed claimed rows", async (row, message) => {
  await expect(database(row).store.claim(baseRow.id)).rejects.toThrow(message);
});

it("records only an allowlisted failure and preserves a terminal late-worker result", async () => {
  const failed = {
    ...baseRow,
    status: "failed" as const,
    attempt_count: 1,
    safe_error: "provider_timeout" as const,
  };
  const db = database(failed, undefined, { ...failed, status: "succeeded" });
  expect(
    await db.store.fail(baseRow.id, "attempt-1", "provider_timeout"),
  ).toMatchObject({ status: "failed", retryable: true });
  expect(db.query.mock.calls[0]![1]).toEqual([
    baseRow.id,
    "attempt-1",
    "provider_timeout",
  ]);
  expect(
    await db.store.fail(baseRow.id, "late-attempt", "provider_unavailable"),
  ).toMatchObject({ status: "succeeded", retryable: false });
});

it("rejects raw or unknown failure values before querying job state", async () => {
  const db = database();
  await expect(
    db.store.fail(
      baseRow.id,
      "attempt-1",
      new Error("credential=synthetic-private") as unknown as SafeJobError,
    ),
  ).rejects.toThrow("allowlisted");
  await expect(
    db.store.fail(baseRow.id, "attempt-1", "unexpected" as SafeJobError),
  ).rejects.toThrow("allowlisted");
  expect(db.query).not.toHaveBeenCalled();
});

it("succeeds only the active attempt and preserves exhaustion against a late success", async () => {
  const db = database(
    { ...baseRow, status: "succeeded", attempt_count: 1 },
    undefined,
    { ...baseRow, status: "exhausted", attempt_count: 3 },
  );
  expect(await db.store.succeed(baseRow.id, "attempt-1")).toMatchObject({
    status: "succeeded",
    safeError: null,
  });
  expect(await db.store.succeed(baseRow.id, "late-attempt")).toMatchObject({
    status: "exhausted",
    retryable: false,
  });
});

it("fails clearly when a conditional transition targets an unknown job", async () => {
  const db = database(undefined, undefined, undefined, undefined);
  await expect(
    db.store.fail("missing", "attempt", "provider_unavailable"),
  ).rejects.toThrow("not found");
  await expect(db.store.succeed("missing", "attempt")).rejects.toThrow(
    "not found",
  );
});

it("enqueues only through an approved registry and binds the input fingerprint", async () => {
  const jobs = runStore();
  const adapters = registry();
  await enqueueAdapterJob(
    jobs,
    adapters,
    "ai",
    "summarize",
    { lesson: 1 },
    "lesson-1",
    4,
  );
  expect(adapters.adapter).toHaveBeenCalledWith("ai", "test");
  expect(jobs.enqueue).toHaveBeenCalledWith(
    "ai",
    "test",
    "summarize",
    "lesson-1",
    fingerprint,
    4,
  );

  const disabled = registry();
  vi.mocked(disabled.adapter).mockImplementation(() => {
    throw new Error("disabled");
  });
  expect(() =>
    enqueueAdapterJob(jobs, disabled, "email", "send", {}, "email-1"),
  ).toThrow("disabled");
  expect(jobs.enqueue).toHaveBeenCalledTimes(1);
});

it("runs a persisted approved attempt to deterministic success", async () => {
  const jobs = runStore();
  const execute = vi.fn().mockResolvedValue({
    kind: "ai",
    mode: "test",
    state: "simulated",
    reference: "test_result",
    message: "simulated",
  });
  const result = await runAdapterJob(jobs, registry(execute), baseRow.id, {
    lesson: 1,
  });
  expect(result).toMatchObject({
    executed: true,
    job: { status: "succeeded" },
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(jobs.succeed).toHaveBeenCalledWith(
    baseRow.id,
    "00000000-0000-4000-8000-000000000002",
  );
});

it("keeps raw adapter errors out of the job persistence boundary", async () => {
  const jobs = runStore();
  const result = await runAdapterJob(
    jobs,
    registry(
      vi.fn().mockRejectedValue(new Error("credential=synthetic-private")),
    ),
    baseRow.id,
    { lesson: 1 },
  );
  expect(result).toMatchObject({
    executed: true,
    result: null,
    job: { status: "failed" },
  });
  expect(jobs.fail).toHaveBeenCalledWith(
    baseRow.id,
    "00000000-0000-4000-8000-000000000002",
    "provider_unavailable",
  );
});

it("rejects missing, mismatched and disabled jobs before claim or invocation", async () => {
  const missing = runStore({ find: vi.fn().mockResolvedValue(undefined) });
  await expect(
    runAdapterJob(missing, registry(), "missing", { lesson: 1 }),
  ).rejects.toThrow("not found");

  const mismatch = runStore();
  const mismatchRegistry = registry();
  await expect(
    runAdapterJob(mismatch, mismatchRegistry, baseRow.id, { lesson: 2 }),
  ).rejects.toThrow("does not match");
  expect(mismatch.claim).not.toHaveBeenCalled();

  const disabled = runStore();
  const disabledRegistry = registry();
  vi.mocked(disabledRegistry.adapter).mockImplementation(() => {
    throw new Error("disabled");
  });
  await expect(
    runAdapterJob(disabled, disabledRegistry, baseRow.id, { lesson: 1 }),
  ).rejects.toThrow("disabled");
  expect(disabled.claim).not.toHaveBeenCalled();
});

it("does not execute an already claimed or terminal job", async () => {
  const latest = publicJob({
    status: "running",
    attempts: 1,
    retryable: false,
  });
  const jobs = runStore({
    find: vi
      .fn()
      .mockResolvedValueOnce(publicJob())
      .mockResolvedValueOnce(latest),
    claim: vi.fn().mockResolvedValue(undefined),
  });
  const execute = vi.fn();
  await expect(
    runAdapterJob(jobs, registry(execute), baseRow.id, { lesson: 1 }),
  ).resolves.toEqual({ job: latest, result: null, executed: false });
  expect(execute).not.toHaveBeenCalled();

  const vanished = runStore({
    find: vi
      .fn()
      .mockResolvedValueOnce(publicJob())
      .mockResolvedValueOnce(undefined),
    claim: vi.fn().mockResolvedValue(undefined),
  });
  await expect(
    runAdapterJob(vanished, registry(), baseRow.id, { lesson: 1 }),
  ).resolves.toMatchObject({ job: { status: "pending" }, executed: false });
});

it("recovers a committed success after an ambiguous acknowledgment", async () => {
  const succeeded = publicJob({
    status: "succeeded",
    attempts: 1,
    retryable: false,
  });
  const jobs = runStore({
    find: vi
      .fn()
      .mockResolvedValueOnce(publicJob())
      .mockResolvedValueOnce(succeeded),
    succeed: vi.fn().mockRejectedValue(new Error("connection lost")),
  });
  await expect(
    runAdapterJob(
      jobs,
      registry(
        vi.fn().mockResolvedValue({
          kind: "ai",
          mode: "test",
          state: "simulated",
          reference: "test_result",
          message: "simulated",
        }),
      ),
      baseRow.id,
      { lesson: 1 },
    ),
  ).resolves.toMatchObject({ job: { status: "succeeded" }, executed: true });
  expect(jobs.fail).not.toHaveBeenCalled();
});

it("reports an unconfirmed completion without rewriting it as provider failure", async () => {
  const jobs = runStore({
    find: vi
      .fn()
      .mockResolvedValueOnce(publicJob())
      .mockResolvedValueOnce(publicJob({ status: "running" })),
    succeed: vi.fn().mockRejectedValue(new Error("connection lost")),
  });
  await expect(
    runAdapterJob(
      jobs,
      registry(
        vi.fn().mockResolvedValue({
          kind: "ai",
          mode: "test",
          state: "simulated",
          reference: "test_result",
          message: "simulated",
        }),
      ),
      baseRow.id,
      { lesson: 1 },
    ),
  ).rejects.toThrow("Could not confirm");
  expect(jobs.fail).not.toHaveBeenCalled();
});
