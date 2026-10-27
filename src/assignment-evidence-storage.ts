import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ObjectStorage } from "./evidence.ts";
import { sampleUuid } from "./sample-feedback-values.ts";
import { assignmentEvidenceName } from "./assignment-evidence-values.ts";

/** An owned logical copy resolves immutable submitted bytes, without another
 * physical object. Keep this wrapper installed when new creation is disabled. */
export function assignmentObjectStorage(
  pool: Pool,
  files: ObjectStorage,
): ObjectStorage {
  async function binding(key: string) {
    if (!sampleUuid(key)) throw Error("Invalid private object key.");
    return (
      await pool.query<{
        bound: boolean;
        response: string | null;
        sequence: number | null;
        bytes: number;
        digest: string;
        sourceDigest: string | null;
        name: string;
        media: string;
      }>(
        `SELECT e.assignment_bound AS bound,e.byte_size AS bytes,e.sha256 AS digest,e.original_name AS name,e.media_type AS media,
       s.response,ao.sequence,ao.source_sha256 AS "sourceDigest"
       FROM evidence_objects e LEFT JOIN assignment_evidence_origins ao ON ao.evidence_id=e.id
        AND ao.workspace_id=e.workspace_id AND ao.member_id=e.owner_principal_id AND ao.storage_key=e.storage_key
       LEFT JOIN assignment_attempts a ON a.id=ao.attempt_id AND a.member_id=ao.member_id
        AND a.content_id=ao.content_id AND a.content_version=ao.content_version
       LEFT JOIN content_versions cv ON cv.id=a.content_id AND cv.version=a.content_version AND cv.rubric_version=ao.rubric_version
       LEFT JOIN assignment_submission_snapshots s ON s.attempt_id=a.id AND s.sequence=ao.sequence
        AND s.submitted_at=ao.submitted_at AND cv.id IS NOT NULL
       WHERE e.storage_key=$1`,
        [key],
      )
    ).rows[0];
  }
  return {
    requiresWriteRecovery: files.requiresWriteRecovery,
    abandon: files.abandon?.bind(files),
    async put(key, data) {
      if ((await binding(key))?.bound)
        throw Error("Assignment private source is immutable.");
      await files.put(key, data);
    },
    async get(key) {
      const row = await binding(key);
      if (!row?.bound) return files.get(key);
      if (
        typeof row.response !== "string" ||
        row.sequence === null ||
        row.media !== "text/plain" ||
        row.name !== assignmentEvidenceName(row.sequence)
      )
        throw Error("Assignment private source unavailable.");
      const bytes = Buffer.from(row.response, "utf8");
      if (
        bytes.length !== row.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== row.digest ||
        row.sourceDigest !== row.digest
      )
        throw Error("Assignment private source unavailable.");
      return bytes;
    },
    async remove(key) {
      // Only the database deletion changes visibility; there is no private file
      // to remove. Missing/damaged origins cannot redirect deletion to a file.
      if (!(await binding(key))?.bound) await files.remove(key);
    },
  };
}
