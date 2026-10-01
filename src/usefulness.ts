import type { Pool } from "pg";
import { hash } from "./store.ts";

export type UsefulnessChoice = "helpful" | "not_yet";
export interface UsefulnessReport {
  contentId: string;
  contentVersion: number;
  choice: UsefulnessChoice;
  revision: number;
  reportedAt: Date;
  updatedAt: Date;
}
export interface UsefulnessStore {
  list(token: string): Promise<UsefulnessReport[]>;
  save(
    token: string,
    contentId: string,
    contentVersion: number,
    choice: UsefulnessChoice,
    expectedRevision: number,
  ): Promise<boolean | null>;
  withdraw(
    token: string,
    contentId: string,
    contentVersion: number,
    expectedRevision: number,
  ): Promise<boolean | null>;
}
export function disabledUsefulnessStore(): UsefulnessStore {
  return {
    list: async () => [],
    save: async () => null,
    withdraw: async () => null,
  };
}

const eligible = `FROM principals p
  JOIN learners l ON l.id=p.id
  JOIN lesson_activity a ON a.member_id=l.id
  JOIN content_versions cv ON cv.id=a.content_id AND cv.version=a.content_version
  WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
    AND p.expires_at>CURRENT_TIMESTAMP
    AND a.content_id=$2 AND a.content_version=$3 AND a.self_assessed_at IS NOT NULL
    AND cv.kind='lesson' AND cv.origin='curated' AND cv.state='published'
    AND NOT cv.requires_qualified_signoff
    AND member_content_eligible(l.id,cv.id,cv.version)
    AND NOT EXISTS(SELECT 1 FROM content_versions newer
      WHERE newer.id=cv.id AND newer.version>cv.version
        AND newer.published_at IS NOT NULL)`;

export function usefulnessStore(pool: Pool): UsefulnessStore {
  // null denies authorization; false preserves an authorized eligibility/revision conflict.
  const changed = async (
    sql: string,
    values: unknown[],
  ): Promise<boolean | null> => {
    const client = await pool.connect();
    let committed = false;
    let releaseError: Error | undefined;
    const rollback = async () => {
      try {
        await client.query("ROLLBACK");
      } catch {
        releaseError = new Error("Usefulness mutation rollback failed");
        throw releaseError;
      }
    };
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='5s'");
      // Match deletion/revocation order before locking activity, content and report rows.
      const principal = (
        await client.query<{ id: string; expiresAt: Date }>(
          `SELECT id,expires_at AS "expiresAt" FROM principals WHERE token_hash=$1
         AND kind='member' AND revoked_at IS NULL
         AND expires_at>clock_timestamp() FOR SHARE`,
          [values[0]],
        )
      ).rows[0];
      if (!principal) return null;
      const workspace = await client.query(
        `SELECT id FROM workspaces WHERE owner_principal_id=$1
         AND deleting_at IS NULL FOR SHARE`,
        [principal.id],
      );
      if (!workspace.rows[0]) return null;
      const result = (await client.query(sql, values)).rowCount === 1;
      // A row or unique-key wait can outlast the principal without changing its tuple.
      const current = await client.query<{ valid: boolean }>(
        "SELECT clock_timestamp() < $1::timestamptz AS valid",
        [principal.expiresAt],
      );
      if (!current.rows[0]?.valid) return null;
      // A lost COMMIT reply is uncertain: discard the connection and never replay it.
      releaseError = new Error("Usefulness mutation commit outcome unknown");
      await client.query("COMMIT");
      committed = true;
      releaseError = undefined;
      return result;
    } finally {
      try {
        if (!committed) await rollback();
      } finally {
        client.release(releaseError);
      }
    }
  };
  return {
    async list(token) {
      return (
        await pool.query<UsefulnessReport>(
          `SELECT u.content_id AS "contentId",u.content_version AS "contentVersion",
             u.choice,u.revision,u.reported_at AS "reportedAt",u.updated_at AS "updatedAt"
           FROM principals p JOIN learners l ON l.id=p.id
           JOIN lesson_usefulness u ON u.member_id=l.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>CURRENT_TIMESTAMP
           ORDER BY u.reported_at,u.content_id,u.content_version`,
          [hash(token)],
        )
      ).rows;
    },
    async save(token, contentId, contentVersion, choice, expectedRevision) {
      if (
        !Number.isSafeInteger(contentVersion) ||
        contentVersion < 1 ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        (choice !== "helpful" && choice !== "not_yet")
      )
        return false;
      if (expectedRevision === 0) {
        return changed(
          `WITH eligible AS MATERIALIZED (
             SELECT l.id AS member_id,a.content_id,a.content_version ${eligible}
             FOR SHARE OF p,l,a,cv
           )
           INSERT INTO lesson_usefulness(member_id,content_id,content_version,choice)
           SELECT member_id,content_id,content_version,$4 FROM eligible
           ON CONFLICT DO NOTHING RETURNING revision`,
          [hash(token), contentId, contentVersion, choice],
        );
      }
      return changed(
        `WITH eligible AS MATERIALIZED (
           SELECT l.id AS member_id,a.content_id,a.content_version ${eligible}
           FOR SHARE OF p,l,a,cv
         )
         UPDATE lesson_usefulness u SET choice=$4,revision=u.revision+1,
           updated_at=CURRENT_TIMESTAMP
         FROM eligible e WHERE u.member_id=e.member_id
           AND u.content_id=e.content_id AND u.content_version=e.content_version
           AND u.revision=$5 RETURNING u.revision`,
        [hash(token), contentId, contentVersion, choice, expectedRevision],
      );
    },
    async withdraw(token, contentId, contentVersion, expectedRevision) {
      if (
        !Number.isSafeInteger(contentVersion) ||
        contentVersion < 1 ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1
      )
        return false;
      return changed(
        `DELETE FROM lesson_usefulness u USING principals p,learners l
         WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
           AND p.expires_at>CURRENT_TIMESTAMP AND l.id=p.id
           AND u.member_id=l.id AND u.content_id=$2 AND u.content_version=$3
           AND u.revision=$4 RETURNING u.revision`,
        [hash(token), contentId, contentVersion, expectedRevision],
      );
    },
  };
}
