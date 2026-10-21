import type { Pool, PoolClient } from "pg";
import type { ObjectStorage } from "./evidence.ts";
import { sampleUuid } from "./sample-feedback-values.ts";

const lockName = (key: string) => {
  if (!sampleUuid(key)) throw Error("Invalid private object key.");
  return `private-object-write:${key.toLowerCase()}`;
};

/** The same checked-out client owns this session lock across the intent's
 * autocommit and the evidence transaction. Discard it if unlock fails. */
export const objectWriteJournal = {
  async prepare(client: PoolClient, key: string) {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      lockName(key),
    ]);
    await client.query(
      "INSERT INTO private_object_write_intents(storage_key) VALUES($1)",
      [key],
    );
  },
  async complete(client: PoolClient, key: string) {
    const result = await client.query(
      "DELETE FROM private_object_write_intents WHERE storage_key=$1",
      [key],
    );
    if (result.rowCount !== 1)
      throw Error("Private object write intent unavailable.");
  },
  async release(client: PoolClient, key: string) {
    const result = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked",
      [lockName(key)],
    );
    if (!result.rows[0]!.unlocked)
      throw Error("Private object write lock unavailable.");
  },
};

export interface ObjectWriteRecoveryPage {
  examined: number;
  completed: number;
  failed: number;
  nextCursor: string | null;
}

async function reconcile(pool: Pool, objects: ObjectStorage, key: string) {
  const client = await pool.connect();
  let commitAttempted = false;
  let released = false;
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
      [lockName(key)],
    );
    if (!lock.rows[0]!.locked) {
      await client.query("ROLLBACK");
      return false;
    }
    const intent = await client.query(
      "SELECT storage_key FROM private_object_write_intents WHERE storage_key=$1 FOR UPDATE",
      [key],
    );
    if (intent.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const source = await client.query<{ referenced: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM evidence_objects WHERE storage_key=$1)
       OR EXISTS(SELECT 1 FROM evidence_derivatives WHERE storage_key=$1) AS referenced`,
      [key],
    );
    if (!source.rows[0]!.referenced) await objects.remove(key);
    await objectWriteJournal.complete(client, key);
    commitAttempted = true;
    await client.query("COMMIT");
    return true;
  } catch (error) {
    if (commitAttempted) {
      client.release(error as Error);
      released = true;
    } else {
      try {
        await client.query("ROLLBACK");
      } catch {
        client.release(error as Error);
        released = true;
      }
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

/** Reconcile only durable intents; never scan a bucket or guess private keys. */
export async function recoverPendingObjectWrites(
  pool: Pool,
  objects: ObjectStorage,
  cursor: string | null = null,
  limit = 10,
): Promise<ObjectWriteRecoveryPage> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== null && !sampleUuid(cursor))
  )
    throw Error("Invalid private object recovery page.");
  const candidates = await pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM private_object_write_intents
     WHERE ($1::uuid IS NULL OR storage_key>$1::uuid) ORDER BY storage_key LIMIT $2`,
    [cursor, limit],
  );
  let completed = 0;
  let failed = 0;
  for (const row of candidates.rows) {
    try {
      if (await reconcile(pool, objects, row.storage_key)) completed++;
    } catch {
      failed++;
    }
  }
  return {
    examined: candidates.rows.length,
    completed,
    failed,
    nextCursor:
      candidates.rows.length === limit
        ? candidates.rows.at(-1)!.storage_key
        : null,
  };
}
