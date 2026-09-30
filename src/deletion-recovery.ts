import type { Pool, PoolClient } from "pg";
import type { ObjectStorage } from "./evidence.ts";

export interface DeletionRecoveryPage {
  examined: number;
  completed: number;
  failed: number;
  nextCursor: string | null;
}

async function rollback(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

async function finishMarkedMember(
  pool: Pool,
  objects: ObjectStorage,
  memberId: string,
): Promise<boolean> {
  const client = await pool.connect();
  let released = false;
  let commitAttempted = false;
  try {
    await client.query("BEGIN");
    // Existing private operations lock the principal before the workspace.
    const principal = await client.query<{ id: string }>(
      "SELECT id FROM principals WHERE id=$1 AND kind='member' FOR UPDATE SKIP LOCKED",
      [memberId],
    );
    if (!principal.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    const workspace = await client.query<{ id: string }>(
      `SELECT id FROM workspaces
       WHERE owner_principal_id=$1 AND deleting_at IS NOT NULL
       FOR UPDATE SKIP LOCKED`,
      [memberId],
    );
    if (!workspace.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    const keys = await client.query<{ storage_key: string }>(
      `SELECT storage_key FROM evidence_objects WHERE workspace_id=$1
       UNION ALL
       SELECT d.storage_key FROM evidence_derivatives d
       JOIN evidence_objects e ON e.id=d.evidence_id
       WHERE e.workspace_id=$1
       ORDER BY storage_key`,
      [workspace.rows[0].id],
    );
    // Metadata and the durable marker survive any failed object removal.
    for (const row of keys.rows) await objects.remove(row.storage_key);
    const deleted = await client.query(
      "DELETE FROM principals WHERE id=$1 AND kind='member'",
      [memberId],
    );
    if (deleted.rowCount !== 1)
      throw new Error("Marked member deletion could not be reconciled.");
    commitAttempted = true;
    await client.query("COMMIT");
    return true;
  } catch (error) {
    if (commitAttempted) {
      // A lost acknowledgement is not evidence of rollback. Discard the
      // connection and read the committed state through a fresh one.
      client.release(error as Error);
      released = true;
      const remaining = await pool.query<{ id: string }>(
        "SELECT id FROM principals WHERE id=$1 AND kind='member'",
        [memberId],
      );
      if (!remaining.rows[0]) return true;
    } else if (!(await rollback(client))) {
      client.release(error as Error);
      released = true;
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

/** Resume only deletion markers previously committed by an owner request. */
export async function recoverPendingMemberDeletions(
  pool: Pool,
  objects: ObjectStorage,
  cursor: string | null = null,
  limit = 10,
): Promise<DeletionRecoveryPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid deletion recovery batch size.");
  const candidates = await pool.query<{ id: string }>(
    `SELECT p.id FROM principals p
     JOIN workspaces w ON w.owner_principal_id=p.id
     WHERE p.kind='member' AND w.deleting_at IS NOT NULL
       AND w.deleting_at<clock_timestamp()-INTERVAL '2 seconds'
       AND ($1::uuid IS NULL OR p.id>$1::uuid)
     ORDER BY p.id LIMIT $2`,
    [cursor, limit],
  );
  let completed = 0;
  let failed = 0;
  for (const candidate of candidates.rows) {
    try {
      if (await finishMarkedMember(pool, objects, candidate.id)) completed++;
    } catch {
      // One broken object or row must not starve later accepted requests.
      failed++;
    }
  }
  return {
    examined: candidates.rows.length,
    completed,
    failed,
    nextCursor:
      candidates.rows.length === limit ? candidates.rows.at(-1)!.id : null,
  };
}
