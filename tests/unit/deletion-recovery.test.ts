import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ObjectStorage } from "../../src/evidence.ts";
import { recoverPendingMemberDeletions } from "../../src/deletion-recovery.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

interface Options {
  absentPrincipal?: string;
  absentWorkspace?: string;
  failObject?: string;
  failDelete?: string;
  failBegin?: boolean;
  failRollback?: boolean;
  failCommit?: boolean;
  committedDespiteError?: boolean;
  failConnect?: boolean;
  failCandidates?: boolean;
}

function database(ids: string[], options: Options = {}) {
  const release = vi.fn();
  const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
    const id = values?.[0] as string;
    if (sql === "BEGIN") {
      if (options.failBegin) throw new Error("begin unavailable");
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      if (options.failRollback) throw new Error("rollback unavailable");
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      if (options.failCommit) throw new Error("commit acknowledgement lost");
      return { rows: [] };
    }
    if (sql.startsWith("SELECT id FROM principals WHERE id=$1"))
      return { rows: id === options.absentPrincipal ? [] : [{ id }] };
    if (sql.startsWith("SELECT id FROM workspaces"))
      return { rows: id === options.absentWorkspace ? [] : [{ id }] };
    if (sql.startsWith("SELECT storage_key FROM evidence_objects"))
      return { rows: [{ storage_key: id }] };
    if (sql.startsWith("DELETE FROM principals"))
      return { rowCount: id === options.failDelete ? 0 : 1, rows: [] };
    throw new Error("Unexpected recovery query");
  });
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT p.id FROM principals p")) {
      if (options.failCandidates)
        throw new Error("candidate query unavailable");
      const [cursor, limit] = values as [string | null, number];
      return {
        rows: ids
          .filter((id) => cursor === null || id > cursor)
          .slice(0, limit)
          .map((id) => ({ id })),
      };
    }
    if (sql.startsWith("SELECT id FROM principals"))
      return {
        rows: options.committedDespiteError ? [] : [{ id: values?.[0] }],
      };
    throw new Error("Unexpected pool query");
  });
  const connect = vi.fn(async () => {
    if (options.failConnect) throw new Error("connection unavailable");
    return { query: clientQuery, release };
  });
  const remove = vi.fn(async (key: string) => {
    if (key === options.failObject)
      throw new Error("private object unavailable");
  });
  return {
    pool: { query, connect } as unknown as Pool,
    objects: { remove } as unknown as ObjectStorage,
    query,
    clientQuery,
    connect,
    release,
    remove,
  };
}

it("selects only bounded marked candidates and removes bytes before principal rows", async () => {
  const db = database([first, second]);
  const page = await recoverPendingMemberDeletions(
    db.pool,
    db.objects,
    null,
    1,
  );
  expect(page).toEqual({
    examined: 1,
    completed: 1,
    failed: 0,
    nextCursor: first,
  });
  expect(db.remove).toHaveBeenCalledWith(first);
  expect(
    db.clientQuery.mock.calls.findIndex(([sql]) => sql === "BEGIN"),
  ).toBeLessThan(
    db.clientQuery.mock.calls.findIndex(([sql]) =>
      sql.startsWith("SELECT id FROM principals"),
    ),
  );
  expect(
    db.clientQuery.mock.calls.findIndex(([sql]) =>
      sql.startsWith("SELECT id FROM principals"),
    ),
  ).toBeLessThan(
    db.clientQuery.mock.calls.findIndex(([sql]) =>
      sql.startsWith("SELECT id FROM workspaces"),
    ),
  );
  expect(db.clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  expect(db.release).toHaveBeenCalledWith();
  const next = await recoverPendingMemberDeletions(
    db.pool,
    db.objects,
    page.nextCursor,
    2,
  );
  expect(next).toEqual({
    examined: 1,
    completed: 1,
    failed: 0,
    nextCursor: null,
  });
  expect(db.remove).toHaveBeenCalledWith(second);
});

it("leaves an empty page and rejects an unbounded batch", async () => {
  const db = database([]);
  expect(await recoverPendingMemberDeletions(db.pool, db.objects)).toEqual({
    examined: 0,
    completed: 0,
    failed: 0,
    nextCursor: null,
  });
  for (const size of [0, 101, 1.5])
    await expect(
      recoverPendingMemberDeletions(db.pool, db.objects, null, size),
    ).rejects.toThrow("Invalid deletion recovery batch size.");
  expect(db.connect).not.toHaveBeenCalled();
});

it("never deletes a candidate without a still-locked principal and marked workspace", async () => {
  for (const options of [
    { absentPrincipal: first },
    { absentWorkspace: first },
  ]) {
    const db = database([first], options);
    const page = await recoverPendingMemberDeletions(db.pool, db.objects);
    expect(page.completed).toBe(0);
    expect(page.failed).toBe(0);
    expect(db.remove).not.toHaveBeenCalled();
    expect(db.clientQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith();
  }
});

it("keeps a broken request recoverable while later marked members advance", async () => {
  const db = database([first, second], { failObject: first });
  const page = await recoverPendingMemberDeletions(
    db.pool,
    db.objects,
    null,
    2,
  );
  expect(page).toEqual({
    examined: 2,
    completed: 1,
    failed: 1,
    nextCursor: second,
  });
  expect(db.clientQuery.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(db.remove).toHaveBeenCalledWith(second);
});

it("retains a marked request when its final database deletion fails", async () => {
  const db = database([first], { failDelete: first });
  expect(
    (await recoverPendingMemberDeletions(db.pool, db.objects)).failed,
  ).toBe(1);
  expect(db.remove).toHaveBeenCalledWith(first);
  expect(db.clientQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
});

it("discards a broken transaction connection after rollback failure", async () => {
  const db = database([first], { failBegin: true, failRollback: true });
  expect(
    (await recoverPendingMemberDeletions(db.pool, db.objects)).failed,
  ).toBe(1);
  expect(db.release).toHaveBeenCalledWith(expect.any(Error));
});

it("reconciles lost commit acknowledgement and never calls it complete when the row remains", async () => {
  const committed = database([first], {
    failCommit: true,
    committedDespiteError: true,
  });
  expect(
    (await recoverPendingMemberDeletions(committed.pool, committed.objects))
      .completed,
  ).toBe(1);
  expect(committed.release).toHaveBeenCalledWith(expect.any(Error));
  const pending = database([first], { failCommit: true });
  expect(
    (await recoverPendingMemberDeletions(pending.pool, pending.objects)).failed,
  ).toBe(1);
  expect(pending.release).toHaveBeenCalledWith(expect.any(Error));
});

it("isolates connect failures but surfaces a failed candidate scan", async () => {
  const connection = database([first, second], { failConnect: true });
  expect(
    await recoverPendingMemberDeletions(
      connection.pool,
      connection.objects,
      null,
      2,
    ),
  ).toEqual({
    examined: 2,
    completed: 0,
    failed: 2,
    nextCursor: second,
  });
  const selection = database([first], { failCandidates: true });
  await expect(
    recoverPendingMemberDeletions(selection.pool, selection.objects),
  ).rejects.toThrow("candidate query unavailable");
});
