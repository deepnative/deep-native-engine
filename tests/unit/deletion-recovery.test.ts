import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ObjectStorage } from "../../src/evidence.ts";
import { recoverPendingMemberDeletions } from "../../src/deletion-recovery.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

const empty = { examined: 0, completed: 0, failed: 0, nextCursor: null };

interface Options {
  evidenceIds?: string[];
  absentEvidence?: string;
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
    if (sql.startsWith("SELECT id FROM evidence_objects"))
      return { rows: id === options.absentEvidence ? [] : [{ id }] };
    if (sql.startsWith("SELECT storage_key FROM evidence_objects"))
      return { rows: [{ storage_key: id }] };
    if (
      sql.startsWith("DELETE FROM principals") ||
      sql.startsWith("DELETE FROM evidence_objects")
    )
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
    if (sql.startsWith("SELECT e.id,e.owner_principal_id")) {
      const [cursor, limit] = values as [string | null, number];
      return {
        rows: (options.evidenceIds ?? [])
          .filter((id) => cursor === null || id > cursor)
          .slice(0, limit)
          .map((id) => ({ id, member_id: id })),
      };
    }
    if (
      sql.startsWith("SELECT id FROM principals") ||
      sql.startsWith("SELECT id FROM evidence_objects")
    )
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

it("HOSTED-06 gives durable object cleanup its own bounded cursor without changing member deletion counts", async () => {
  const db = database([]);
  const query = db.query.getMockImplementation()!;
  db.query.mockImplementation(async (sql, values) =>
    sql.includes("private_object_write_intents")
      ? { rows: [] }
      : query(sql, values),
  );
  const page = await recoverPendingMemberDeletions(
    db.pool,
    { ...db.objects, requiresWriteRecovery: true },
    first,
    1,
    second,
  );
  expect(page).toEqual({
    examined: 0,
    completed: 0,
    failed: 0,
    nextCursor: null,
    evidenceDeletions: empty,
    objectWrites: { examined: 0, completed: 0, failed: 0, nextCursor: null },
  });
  expect(db.query).toHaveBeenCalledWith(
    expect.stringContaining("private_object_write_intents"),
    [second, 1],
  );
});
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
    evidenceDeletions: empty,
  });
  expect(db.remove).toHaveBeenCalledWith(
    first,
    expect.objectContaining({ query: db.clientQuery }),
  );
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
    evidenceDeletions: empty,
  });
  expect(db.remove).toHaveBeenCalledWith(
    second,
    expect.objectContaining({ query: db.clientQuery }),
  );
});

it("leaves an empty page and rejects an unbounded batch", async () => {
  const db = database([]);
  expect(await recoverPendingMemberDeletions(db.pool, db.objects)).toEqual({
    examined: 0,
    completed: 0,
    failed: 0,
    nextCursor: null,
    evidenceDeletions: empty,
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
    evidenceDeletions: empty,
  });
  expect(db.clientQuery.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
  expect(db.remove).toHaveBeenCalledWith(
    second,
    expect.objectContaining({ query: db.clientQuery }),
  );
});

it("retains a marked request when its final database deletion fails", async () => {
  const db = database([first], { failDelete: first });
  expect(
    (await recoverPendingMemberDeletions(db.pool, db.objects)).failed,
  ).toBe(1);
  expect(db.remove).toHaveBeenCalledWith(
    first,
    expect.objectContaining({ query: db.clientQuery }),
  );
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
    evidenceDeletions: empty,
  });
  const selection = database([first], { failCandidates: true });
  await expect(
    recoverPendingMemberDeletions(selection.pool, selection.objects),
  ).rejects.toThrow("candidate query unavailable");
});

it("AUDIT-DELETE-01 keeps individual deletion paging independent of member and object-write recovery", async () => {
  const db = database([], { evidenceIds: [first, second], failObject: first });
  const failed = await recoverPendingMemberDeletions(
    db.pool,
    db.objects,
    second,
    1,
    null,
  );
  expect(failed.evidenceDeletions).toEqual({
    examined: 1,
    completed: 0,
    failed: 1,
    nextCursor: first,
  });
  const next = await recoverPendingMemberDeletions(
    db.pool,
    db.objects,
    null,
    1,
    null,
    first,
  );
  expect(next.evidenceDeletions).toEqual({
    examined: 1,
    completed: 1,
    failed: 0,
    nextCursor: second,
  });
  expect(db.clientQuery).toHaveBeenCalledWith(
    "DELETE FROM evidence_objects WHERE id=$1 AND quarantine_state='deleting'",
    [second],
  );
  expect(
    db.clientQuery.mock.calls.some(([sql]) =>
      sql.startsWith("DELETE FROM principals"),
    ),
  ).toBe(false);
});
it.each([
  { absentPrincipal: first },
  { absentWorkspace: first },
  { absentEvidence: first },
])(
  "AUDIT-DELETE-01 skips an unavailable individual deletion fence %j",
  async (options) => {
    const db = database([], { evidenceIds: [first], ...options });
    expect(
      (await recoverPendingMemberDeletions(db.pool, db.objects))
        .evidenceDeletions,
    ).toEqual({ examined: 1, completed: 0, failed: 0, nextCursor: null });
    expect(db.remove).not.toHaveBeenCalled();
  },
);
it.each([
  { failDelete: first },
  { failConnect: true },
  { failBegin: true, failRollback: true },
  { failCommit: true },
])(
  "AUDIT-DELETE-01 retains individual deletion after database failure %j",
  async (options) => {
    const db = database([], { evidenceIds: [first], ...options });
    expect(
      (await recoverPendingMemberDeletions(db.pool, db.objects))
        .evidenceDeletions.failed,
    ).toBe(1);
  },
);
it("AUDIT-DELETE-01 reconciles an acknowledged-lost individual deletion against its own metadata", async () => {
  const db = database([], {
    evidenceIds: [first],
    failCommit: true,
    committedDespiteError: true,
  });
  expect(
    (await recoverPendingMemberDeletions(db.pool, db.objects)).evidenceDeletions
      .completed,
  ).toBe(1);
  expect(db.query).toHaveBeenCalledWith(
    "SELECT id FROM evidence_objects WHERE id=$1",
    [first],
  );
});
