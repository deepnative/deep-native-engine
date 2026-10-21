import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  objectWriteJournal,
  recoverPendingObjectWrites,
} from "../../src/object-write-recovery.ts";

const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const later = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function fixture(
  options: {
    locked?: boolean;
    present?: boolean;
    referenced?: boolean;
    failure?: string;
    rollbackFails?: boolean;
    completedRows?: number;
    candidates?: string[];
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "ROLLBACK" && options.rollbackFails)
      throw Error("private rollback detail");
    if (options.failure && sql.includes(options.failure))
      throw Error("private database detail");
    if (sql.includes(" AS locked"))
      return { rows: [{ locked: options.locked ?? true }], rowCount: 1 };
    if (sql.includes("FOR UPDATE"))
      return { rows: [], rowCount: options.present === false ? 0 : 1 };
    if (sql.includes(" AS referenced"))
      return {
        rows: [{ referenced: options.referenced ?? false }],
        rowCount: 1,
      };
    if (sql.includes(" AS unlocked"))
      return { rows: [{ unlocked: true }], rowCount: 1 };
    return { rows: [], rowCount: options.completedRows ?? 1 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const listing = vi.fn(async () => ({
    rows: (options.candidates ?? [key]).map((storage_key) => ({ storage_key })),
  }));
  const connect = vi.fn(async () => client);
  const pool = { query: listing, connect } as unknown as Pool;
  const objects = {
    requiresWriteRecovery: true as const,
    put: vi.fn(),
    get: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { pool, client, query, release, listing, connect, objects };
}

it("HOSTED-06 records durable intent outside the business transaction and releases the exact session lock", async () => {
  const f = fixture();
  await objectWriteJournal.prepare(f.client, key);
  expect(f.query.mock.calls.map(([sql]) => sql.split(" ")[0])).toEqual([
    "SELECT",
    "INSERT",
  ]);
  expect(f.query).toHaveBeenNthCalledWith(
    1,
    expect.stringContaining("pg_advisory_lock"),
    [`private-object-write:${key}`],
  );
  await objectWriteJournal.complete(f.client, key);
  await objectWriteJournal.release(f.client, key);
  expect(f.query).toHaveBeenLastCalledWith(
    expect.stringContaining("pg_advisory_unlock"),
    [`private-object-write:${key}`],
  );
});
it("HOSTED-06 rejects invalid intent keys, missing completion and an unconfirmed unlock", async () => {
  const f = fixture({ completedRows: 0 });
  await expect(
    objectWriteJournal.prepare(f.client, "../private"),
  ).rejects.toThrow("Invalid private object key.");
  expect(f.query).not.toHaveBeenCalled();
  await expect(objectWriteJournal.complete(f.client, key)).rejects.toThrow(
    "intent unavailable",
  );
  f.query.mockResolvedValueOnce({ rows: [{ unlocked: false }], rowCount: 1 });
  await expect(objectWriteJournal.release(f.client, key)).rejects.toThrow(
    "lock unavailable",
  );
});
it.each([false, true])(
  "HOSTED-06 reconciles durable intent without removing a referenced object: referenced=%s",
  async (referenced) => {
    const f = fixture({ referenced });
    expect(await recoverPendingObjectWrites(f.pool, f.objects)).toEqual({
      examined: 1,
      completed: 1,
      failed: 0,
      nextCursor: null,
    });
    expect(f.objects.remove).toHaveBeenCalledTimes(referenced ? 0 : 1);
    if (!referenced) expect(f.objects.remove).toHaveBeenCalledWith(key);
    expect(f.query).toHaveBeenLastCalledWith("COMMIT");
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  },
);
it.each([{ locked: false }, { present: false }])(
  "HOSTED-06 skips an active writer or already-completed intent without touching bytes %#",
  async (options) => {
    const f = fixture(options);
    expect(await recoverPendingObjectWrites(f.pool, f.objects)).toMatchObject({
      completed: 0,
      failed: 0,
    });
    expect(f.objects.remove).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  },
);
it("HOSTED-06 retains failed object removal for a later cycle without a repeated storage call", async () => {
  const f = fixture();
  f.objects.remove.mockRejectedValue(Error("private provider detail"));
  expect(await recoverPendingObjectWrites(f.pool, f.objects)).toMatchObject({
    completed: 0,
    failed: 1,
  });
  expect(f.objects.remove).toHaveBeenCalledExactlyOnceWith(key);
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(
    false,
  );
  expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(f.release).toHaveBeenCalledExactlyOnceWith();
});
it.each([
  { failure: "AS referenced", rollbackFails: true },
  { failure: "COMMIT" },
])(
  "HOSTED-06 discards a failed rollback or ambiguous commit connection %#",
  async (options) => {
    const f = fixture(options);
    expect(await recoverPendingObjectWrites(f.pool, f.objects)).toMatchObject({
      completed: 0,
      failed: 1,
    });
    expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  },
);
it("HOSTED-06 retains an intent if database completion cannot be confirmed", async () => {
  const f = fixture({ completedRows: 0 });
  expect(await recoverPendingObjectWrites(f.pool, f.objects)).toMatchObject({
    completed: 0,
    failed: 1,
  });
  expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
});
it("HOSTED-06 advances bounded fair pages past a failed connection and resets at the end", async () => {
  const f = fixture({ candidates: [key, later] });
  f.connect.mockRejectedValueOnce(Error("private connection failure"));
  expect(await recoverPendingObjectWrites(f.pool, f.objects, key, 2)).toEqual({
    examined: 2,
    completed: 1,
    failed: 1,
    nextCursor: later,
  });
  expect(f.listing).toHaveBeenCalledWith(expect.any(String), [key, 2]);
  const empty = fixture({ candidates: [] });
  expect(
    await recoverPendingObjectWrites(empty.pool, empty.objects, later),
  ).toEqual({ examined: 0, completed: 0, failed: 0, nextCursor: null });
  expect(empty.connect).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, 101])(
  "HOSTED-06 refuses invalid cleanup batch size %s",
  async (limit) => {
    const f = fixture();
    await expect(
      recoverPendingObjectWrites(f.pool, f.objects, null, limit),
    ).rejects.toThrow("Invalid private object recovery page.");
    expect(f.listing).not.toHaveBeenCalled();
  },
);
it("HOSTED-06 refuses a malformed recovery cursor before database work", async () => {
  const f = fixture();
  await expect(
    recoverPendingObjectWrites(f.pool, f.objects, "invalid"),
  ).rejects.toThrow("Invalid private object recovery page.");
  expect(f.listing).not.toHaveBeenCalled();
});
