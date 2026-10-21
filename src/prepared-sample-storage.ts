import type { Pool } from "pg";
import type { ObjectStorage } from "./evidence.ts";
import { preparedSample } from "./prepared-sample-values.ts";
import { sampleUuid } from "./sample-feedback-values.ts";

/** Fixed provided bytes have no per-member physical file. Only an extant exact
 * source binding resolves them; deletion removes that binding, not the public
 * template definition. Always installed, including creation-off rollback. */
export function preparedObjectStorage(
  pool: Pool,
  files: ObjectStorage,
): ObjectStorage {
  async function binding(key: string) {
    if (!sampleUuid(key)) throw Error("Invalid private object key.");
    return (
      await pool.query<{
        templateId: string;
        templateVersion: number;
        templateDigest: string;
        bytes: number;
        digest: string;
        name: string;
        media: string;
      }>(
        `SELECT o.template_id AS "templateId",o.template_version AS "templateVersion",
      o.template_digest AS "templateDigest",e.byte_size AS bytes,e.sha256 AS digest,
      e.original_name AS name,e.media_type AS media
      FROM provided_evidence_origins o JOIN evidence_objects e ON e.id=o.evidence_id
       AND e.storage_key=o.storage_key AND e.workspace_id=o.workspace_id AND e.owner_principal_id=o.member_id
      WHERE o.storage_key=$1`,
        [key],
      )
    ).rows[0];
  }
  return {
    requiresWriteRecovery: files.requiresWriteRecovery,
    abandon: files.abandon?.bind(files),
    async put(key, data) {
      if (await binding(key))
        throw Error("Provided private source is immutable.");
      await files.put(key, data);
    },
    async get(key) {
      const row = await binding(key);
      if (!row) return files.get(key);
      const sample = preparedSample(
        row.templateId,
        row.templateVersion,
        row.templateDigest,
      );
      if (
        !sample ||
        row.digest !== sample.digest ||
        row.bytes !== Buffer.byteLength(sample.text) ||
        row.name !== sample.name ||
        row.media !== "text/plain"
      )
        throw Error("Provided private source unavailable.");
      return Buffer.from(sample.text);
    },
    async remove(key) {
      // Source removal controls access through its retained database binding.
      // No private byte write/orphan exists for these immutable fixed examples.
      if (!(await binding(key))) await files.remove(key);
    },
  };
}
