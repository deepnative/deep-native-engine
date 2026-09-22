import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { basename, join, resolve } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

export const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const EVIDENCE_TYPES = [
  "text/plain",
  "image/png",
  "application/pdf",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export type QuarantineResult = "clean" | "rejected" | "infected";
export type Destination =
  "private-review" | "community-publication" | `learning-circle:${string}`;

export interface EvidenceConsent {
  rightsConfirmed: boolean;
  privateReview: boolean;
  communityPublication: boolean;
  learningCircleId?: string;
}

export interface EvidenceUpload {
  name: string;
  mediaType: string;
  consent: EvidenceConsent;
  data: Buffer;
}

export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

type Denied = { kind: "denied" };
type Invalid = { kind: "invalid" };
type EvidenceMetadata = {
  id: string;
  workspace_id: string;
  original_name: string;
  media_type: EvidenceType;
  storage_key: string;
};

export interface EvidenceStore {
  upload(
    token: string,
    input: EvidenceUpload,
  ): Promise<
    Denied | Invalid | { kind: "created"; id: string; state: "pending" }
  >;
  transitionQuarantine(
    evidenceId: string,
    result: QuarantineResult,
  ): Promise<boolean>;
  submitForReview(token: string, evidenceId: string): Promise<boolean>;
  destinationAllowed(
    evidenceId: string,
    destination: Destination,
  ): Promise<boolean>;
  issueDownload(
    token: string,
    evidenceId: string,
  ): Promise<Denied | { kind: "issued"; capability: string; expiresAt: Date }>;
  download(
    token: string,
    evidenceId: string,
    capability: string,
  ): Promise<
    | Denied
    | {
        kind: "allowed";
        name: string;
        mediaType: EvidenceType;
        data: Buffer;
      }
  >;
  addDerivative(
    evidenceId: string,
    kind: "text-extract" | "thumbnail",
    data: Buffer,
  ): Promise<string>;
  remove(token: string, evidenceId: string): Promise<boolean>;
  removeWorkspace(token: string): Promise<void>;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[a-f0-9]{64}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,199}$/;
const circlePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

function validSignature(mediaType: EvidenceType, data: Buffer) {
  if (mediaType === "application/pdf")
    return data.subarray(0, 5).toString() === "%PDF-";
  if (mediaType === "image/png")
    return data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return !data.includes(0);
}

export function validUpload(input: EvidenceUpload) {
  const mediaType = input.mediaType as EvidenceType;
  const circle = input.consent.learningCircleId;
  return (
    Buffer.isBuffer(input.data) &&
    input.data.length > 0 &&
    input.data.length <= MAX_EVIDENCE_BYTES &&
    EVIDENCE_TYPES.includes(mediaType) &&
    validSignature(mediaType, input.data) &&
    input.name === basename(input.name) &&
    namePattern.test(input.name) &&
    input.consent.rightsConfirmed &&
    (input.consent.privateReview ||
      input.consent.communityPublication ||
      circle !== undefined) &&
    (circle === undefined || circlePattern.test(circle))
  );
}

function safeKey(key: string) {
  if (!uuidPattern.test(key)) throw new Error("Invalid private object key.");
  return key;
}

export function fileObjectStorage(root: string): ObjectStorage {
  const directory = resolve(root);
  const path = (key: string) => join(directory, safeKey(key));
  return {
    async put(key, data) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path(key), data, { flag: "wx", mode: 0o600 });
    },
    get(key) {
      return readFile(path(key));
    },
    async remove(key) {
      await rm(path(key), { force: true });
    },
  };
}

export function disabledEvidenceStore(): EvidenceStore {
  const denied = async () => ({ kind: "denied" }) as const;
  const unavailable = async () => {
    throw new Error("Private evidence storage is not configured.");
  };
  return {
    upload: denied,
    transitionQuarantine: async () => false,
    submitForReview: async () => false,
    destinationAllowed: async () => false,
    issueDownload: denied,
    download: denied,
    addDerivative: unavailable,
    remove: async () => false,
    removeWorkspace: async () => undefined,
  };
}

export function evidenceStore(
  pool: Pool,
  objects: ObjectStorage,
  secret: string,
  clock: () => number = Date.now,
): EvidenceStore {
  async function rollback(client: PoolClient) {
    try {
      await client.query("ROLLBACK");
      return true;
    } catch {
      // The original database error is more useful; a broken connection is discarded.
      return false;
    }
  }

  async function reconcileCommit(
    table: "evidence_objects" | "evidence_derivatives",
    id: string,
    storageKey: string,
  ) {
    try {
      return Boolean(
        (
          await pool.query(
            `SELECT id FROM ${table} WHERE id=$1 AND storage_key=$2`,
            [id, storageKey],
          )
        ).rows[0],
      );
    } catch {
      return undefined;
    }
  }

  function signature(evidenceId: string, expires: number, nonce: string) {
    return createHmac("sha256", secret)
      .update(`${evidenceId}.${expires}.${nonce}`)
      .digest("hex");
  }

  function validCapability(
    evidenceId: string,
    capability: string,
    now: number,
  ) {
    const [expiresRaw, nonce, supplied, extra] = capability.split(".");
    const expires = Number(expiresRaw);
    if (
      extra !== undefined ||
      !Number.isSafeInteger(expires) ||
      expires <= now ||
      !/^[a-f0-9]{48}$/.test(nonce ?? "") ||
      !/^[a-f0-9]{64}$/.test(supplied ?? "")
    )
      return false;
    const expected = signature(evidenceId, expires, nonce!);
    return timingSafeEqual(
      Buffer.from(supplied!, "hex"),
      Buffer.from(expected, "hex"),
    );
  }

  async function accessible(token: string, evidenceId: string) {
    if (!tokenPattern.test(token) || !uuidPattern.test(evidenceId)) return;
    return (
      await pool.query<EvidenceMetadata>(
        `WITH identity AS (
           SELECT p.id,p.kind,s.role
           FROM principals p LEFT JOIN staff_profiles s ON s.principal_id=p.id
           WHERE p.token_hash=$1 AND p.revoked_at IS NULL
             AND p.expires_at>CURRENT_TIMESTAMP
         )
         SELECT e.id,e.workspace_id,e.original_name,e.media_type,e.storage_key
         FROM evidence_objects e CROSS JOIN identity i
         WHERE e.id=$2 AND e.quarantine_state='clean' AND (
           (i.kind='member' AND i.id=e.owner_principal_id)
           OR (i.kind='staff' AND e.private_review_allowed AND EXISTS(
             SELECT 1 FROM assignment_grants g
             WHERE g.staff_id=i.id AND g.staff_role=i.role
               AND g.workspace_id=e.workspace_id AND g.revoked_at IS NULL
               AND g.starts_at<=CURRENT_TIMESTAMP AND g.expires_at>CURRENT_TIMESTAMP
           ))
           OR (i.kind='member' AND e.learning_circle_id IS NOT NULL AND EXISTS(
             SELECT 1 FROM cohort_memberships m
             WHERE m.member_id=i.id AND m.cohort_id=e.learning_circle_id
               AND m.can_read_shared_content AND m.revoked_at IS NULL
               AND (m.expires_at IS NULL OR m.expires_at>CURRENT_TIMESTAMP)
           ))
         )`,
        [hash(token), evidenceId],
      )
    ).rows[0];
  }

  async function removeKeys(keys: string[]) {
    for (const key of keys) await objects.remove(key);
  }

  return {
    async upload(token, input) {
      if (!tokenPattern.test(token)) return { kind: "denied" };
      if (!validUpload(input)) return { kind: "invalid" };
      const id = randomUUID(),
        storageKey = randomUUID(),
        circle = input.consent.learningCircleId ?? null,
        client = await pool.connect();
      let objectWritten = false,
        commitAttempted = false,
        released = false,
        releaseError: Error | undefined;
      try {
        await client.query("BEGIN");
        const owner = (
          await client.query<{ principal_id: string; workspace_id: string }>(
            `SELECT p.id AS principal_id,w.id AS workspace_id
             FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
               AND p.expires_at>CURRENT_TIMESTAMP AND w.deleting_at IS NULL
               AND ($2::text IS NULL OR EXISTS(
                 SELECT 1 FROM cohort_memberships m
                 WHERE m.cohort_id=$2 AND m.member_id=p.id
                   AND m.can_read_shared_content AND m.revoked_at IS NULL
                   AND (m.expires_at IS NULL OR m.expires_at>CURRENT_TIMESTAMP)
               ))
             FOR UPDATE OF w`,
            [hash(token), circle],
          )
        ).rows[0];
        if (!owner) {
          await client.query("ROLLBACK");
          return { kind: "denied" };
        }
        await objects.put(storageKey, input.data);
        objectWritten = true;
        await client.query(
          `INSERT INTO evidence_objects(
             id,workspace_id,owner_principal_id,original_name,media_type,
             byte_size,sha256,storage_key,private_review_allowed,
             community_publication_allowed,learning_circle_id,rights_attested_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
          [
            id,
            owner.workspace_id,
            owner.principal_id,
            input.name,
            input.mediaType,
            input.data.length,
            createHash("sha256").update(input.data).digest("hex"),
            storageKey,
            input.consent.privateReview,
            input.consent.communityPublication,
            circle,
          ],
        );
        commitAttempted = true;
        await client.query("COMMIT");
        return { kind: "created", id, state: "pending" };
      } catch (error) {
        if (!commitAttempted) {
          if (!(await rollback(client))) releaseError = error as Error;
          if (objectWritten) await objects.remove(storageKey);
        } else {
          client.release(error as Error);
          released = true;
          const committed = await reconcileCommit(
            "evidence_objects",
            id,
            storageKey,
          );
          if (committed) return { kind: "created", id, state: "pending" };
        }
        throw error;
      } finally {
        if (!released) client.release(releaseError);
      }
    },
    async transitionQuarantine(evidenceId, result) {
      if (
        !uuidPattern.test(evidenceId) ||
        !["clean", "rejected", "infected"].includes(result)
      )
        return false;
      return Boolean(
        (
          await pool.query(
            `UPDATE evidence_objects SET quarantine_state=$2,scanned_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND quarantine_state='pending' RETURNING id`,
            [evidenceId, result],
          )
        ).rows[0],
      );
    },
    async submitForReview(token, evidenceId) {
      if (!tokenPattern.test(token) || !uuidPattern.test(evidenceId))
        return false;
      return Boolean(
        (
          await pool.query(
            `INSERT INTO evidence_review_submissions(id,evidence_id,submitted_by)
             SELECT $3,e.id,p.id FROM evidence_objects e
             JOIN principals p ON p.id=e.owner_principal_id
             WHERE e.id=$2 AND p.token_hash=$1 AND p.kind='member'
               AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
               AND e.quarantine_state='clean' AND e.private_review_allowed
             ON CONFLICT(evidence_id) DO NOTHING RETURNING id`,
            [hash(token), evidenceId, randomUUID()],
          )
        ).rows[0],
      );
    },
    async destinationAllowed(evidenceId, destination) {
      if (!uuidPattern.test(evidenceId)) return false;
      const [kind, circle, extra] = destination.split(":");
      if (extra !== undefined) return false;
      const column =
        kind === "private-review"
          ? "private_review_allowed"
          : kind === "community-publication"
            ? "community_publication_allowed"
            : kind === "learning-circle" && circlePattern.test(circle ?? "")
              ? "learning_circle_id"
              : undefined;
      if (!column) return false;
      const condition =
        column === "learning_circle_id" ? `${column}=$2` : `${column}=true`;
      return Boolean(
        (
          await pool.query(
            `SELECT id FROM evidence_objects
             WHERE id=$1 AND quarantine_state='clean' AND ${condition}`,
            column === "learning_circle_id"
              ? [evidenceId, circle]
              : [evidenceId],
          )
        ).rows[0],
      );
    },
    async issueDownload(token, evidenceId) {
      if (!(await accessible(token, evidenceId))) return { kind: "denied" };
      const expires = clock() + 5 * 60 * 1000,
        nonce = randomBytes(24).toString("hex");
      return {
        kind: "issued",
        capability: `${expires}.${nonce}.${signature(evidenceId, expires, nonce)}`,
        expiresAt: new Date(expires),
      };
    },
    async download(token, evidenceId, capability) {
      if (!validCapability(evidenceId, capability, clock()))
        return { kind: "denied" };
      const row = await accessible(token, evidenceId);
      if (!row) return { kind: "denied" };
      return {
        kind: "allowed",
        name: row.original_name,
        mediaType: row.media_type,
        data: await objects.get(row.storage_key),
      };
    },
    async addDerivative(evidenceId, kind, data) {
      if (
        !uuidPattern.test(evidenceId) ||
        !["text-extract", "thumbnail"].includes(kind) ||
        !Buffer.isBuffer(data) ||
        data.length < 1 ||
        data.length > MAX_EVIDENCE_BYTES
      )
        throw new Error("Invalid evidence derivative.");
      const id = randomUUID(),
        storageKey = randomUUID(),
        client = await pool.connect();
      let objectWritten = false,
        commitAttempted = false,
        released = false,
        releaseError: Error | undefined;
      try {
        await client.query("BEGIN");
        const source = (
          await client.query<{ id: string }>(
            `SELECT id FROM evidence_objects
             WHERE id=$1 AND quarantine_state='clean' FOR UPDATE`,
            [evidenceId],
          )
        ).rows[0];
        if (!source) {
          await client.query("ROLLBACK");
          throw new Error("Evidence derivative could not be stored.");
        }
        await objects.put(storageKey, data);
        objectWritten = true;
        await client.query(
          `INSERT INTO evidence_derivatives(
             id,evidence_id,kind,storage_key,byte_size,sha256
           ) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            id,
            evidenceId,
            kind,
            storageKey,
            data.length,
            createHash("sha256").update(data).digest("hex"),
          ],
        );
        commitAttempted = true;
        await client.query("COMMIT");
        return id;
      } catch (error) {
        if (!commitAttempted) {
          if (!(await rollback(client))) releaseError = error as Error;
          if (objectWritten) await objects.remove(storageKey);
        } else {
          client.release(error as Error);
          released = true;
          const committed = await reconcileCommit(
            "evidence_derivatives",
            id,
            storageKey,
          );
          if (committed) return id;
        }
        throw error;
      } finally {
        if (!released) client.release(releaseError);
      }
    },
    async remove(token, evidenceId) {
      if (!tokenPattern.test(token) || !uuidPattern.test(evidenceId))
        return false;
      const marked = await pool.query(
        `UPDATE evidence_objects e SET quarantine_state='deleting'
         FROM principals p
         WHERE e.id=$2 AND p.id=e.owner_principal_id AND p.token_hash=$1
           AND p.kind='member' AND p.revoked_at IS NULL
           AND p.expires_at>CURRENT_TIMESTAMP RETURNING e.id`,
        [hash(token), evidenceId],
      );
      if (!marked.rows[0]) return false;
      const rows = (
        await pool.query<{ storage_key: string }>(
          `SELECT storage_key FROM evidence_objects
           WHERE id=$1 AND quarantine_state='deleting'
           UNION ALL
           SELECT d.storage_key FROM evidence_derivatives d
           JOIN evidence_objects e ON e.id=d.evidence_id
           WHERE e.id=$1 AND e.quarantine_state='deleting'`,
          [evidenceId],
        )
      ).rows;
      await removeKeys(rows.map((row) => row.storage_key));
      await pool.query(
        "DELETE FROM evidence_objects WHERE id=$1 AND quarantine_state='deleting'",
        [evidenceId],
      );
      return true;
    },
    async removeWorkspace(token) {
      if (!tokenPattern.test(token)) return;
      const client = await pool.connect();
      let workspaceId: string | undefined,
        released = false;
      try {
        await client.query("BEGIN");
        workspaceId = (
          await client.query<{ id: string }>(
            `SELECT w.id FROM workspaces w JOIN principals p ON p.id=w.owner_principal_id
             WHERE p.token_hash=$1 AND p.kind='member' FOR UPDATE OF w`,
            [hash(token)],
          )
        ).rows[0]?.id;
        if (!workspaceId) {
          await client.query("ROLLBACK");
          return;
        }
        await client.query(
          `UPDATE workspaces SET deleting_at=COALESCE(deleting_at,CURRENT_TIMESTAMP)
           WHERE id=$1`,
          [workspaceId],
        );
        await client.query(
          `UPDATE evidence_objects SET quarantine_state='deleting'
           WHERE workspace_id=$1`,
          [workspaceId],
        );
        await client.query("COMMIT");
      } catch (error) {
        if (!(await rollback(client))) {
          client.release(error as Error);
          released = true;
        }
        throw error;
      } finally {
        if (!released) client.release();
      }
      const rows = (
        await pool.query<{ id: string; storage_key: string }>(
          `SELECT id,storage_key FROM evidence_objects
           WHERE workspace_id=$1 AND quarantine_state='deleting'
           UNION ALL
           SELECT e.id,d.storage_key FROM evidence_derivatives d
           JOIN evidence_objects e ON e.id=d.evidence_id
           WHERE e.workspace_id=$1 AND e.quarantine_state='deleting'`,
          [workspaceId],
        )
      ).rows;
      await removeKeys(rows.map((row) => row.storage_key));
      if (rows[0])
        await pool.query(
          "DELETE FROM evidence_objects WHERE id=ANY($1::uuid[]) AND quarantine_state='deleting'",
          [Array.from(new Set(rows.map((row) => row.id)))],
        );
    },
  };
}
