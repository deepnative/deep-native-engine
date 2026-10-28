import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { hash } from "./store.ts";
import type { DraftContent } from "./catalog.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "./practice-session-lifetime.ts";

export type ReviewedContentImportResult =
  "imported" | "existing" | "conflict" | "denied" | "unavailable";
export interface ReviewedContentImportStore {
  import(token: string): Promise<ReviewedContentImportResult>;
}
export function reviewedContentImportStore(
  pool: Pool,
  loadPack: () => Promise<DraftContent[]>,
  lockScope: 103 | 117,
): ReviewedContentImportStore {
  return {
    async import(token) {
      try {
        return await practiceTransaction(pool, async (tx) => {
          const principal = (
            await tx.query<{ id: string; expires: Date }>(
              `SELECT id,expires_at AS expires FROM principals
             WHERE token_hash=$1 AND kind='staff' AND revoked_at IS NULL
             AND expires_at>clock_timestamp() FOR SHARE`,
              [hash(token)],
            )
          ).rows[0];
          if (!principal) throw new PracticeLifetimeFailure("denied");
          await tx.observe([principal.expires]);
          const editor = await tx.query(
            "SELECT principal_id FROM staff_profiles WHERE principal_id=$1 AND role='editor' FOR SHARE",
            [principal.id],
          );
          if (!editor.rows[0]) throw new PracticeLifetimeFailure("denied");
          const pack = await tx.bounded(loadPack);
          // Serialize imports; a conflicting ordinary catalog INSERT still fails
          // the whole transaction at the unique constraint, never a partial pack.
          await tx.query("SELECT pg_advisory_xact_lock($1,20261027)", [
            lockScope,
          ]);
          const rows = (
            await tx.query(
              `SELECT * FROM content_versions WHERE id=ANY($1::text[]) ORDER BY id,version FOR SHARE`,
              [pack.map((x) => x.id)],
            )
          ).rows;
          const payloads = pack.map((item) => ({
            id: item.id,
            version: item.version,
            kind: item.kind,
            origin: item.origin,
            title: item.title,
            body: item.body,
            owner: item.owner,
            sources: item.sources,
            rights: item.rights,
            goals: item.goals,
            backgrounds: item.backgrounds,
            domains: item.domains,
            prerequisites: item.prerequisites,
            structured_prerequisites: item.structuredPrerequisites,
            minimum_experience: item.minimumExperience,
            rubric: item.rubric,
            rubric_version: item.rubricVersion,
            requires_qualified_signoff: false,
          }));
          const originals = rows.filter((row) => row.version === 1);
          const newer = rows.filter((row) => row.version !== 1);
          const existing =
            newer.length === pack.length &&
            payloads.every((expected) => {
              const row = newer.find((row) => row.id === expected.id);
              return (
                row &&
                Object.entries(expected).every(([key, value]) =>
                  isDeepStrictEqual(row[key], value),
                )
              );
            });
          const conflict =
            originals.length !== pack.length ||
            rows.some((row) => row.state === "retired") ||
            (newer.length > 0 && !existing);
          if (!conflict && !existing) {
            await tx.query(
              `INSERT INTO content_versions
              (id,version,kind,origin,title,body,owner,sources,rights,goals,backgrounds,domains,prerequisites,
               structured_prerequisites,minimum_experience,rubric,rubric_version,requires_qualified_signoff,created_by)
              SELECT id,version,kind,origin,title,body,owner,sources,rights,goals,backgrounds,domains,prerequisites,
                structured_prerequisites,minimum_experience,rubric,rubric_version,requires_qualified_signoff,$2::uuid
              FROM jsonb_to_recordset($1::jsonb) AS x(id text,version integer,kind text,origin text,title text,
                body text,owner text,sources text,rights text,goals text[],backgrounds text[],domains text[],prerequisites text,
                structured_prerequisites jsonb,minimum_experience text,rubric text,rubric_version integer,requires_qualified_signoff boolean)`,
              [JSON.stringify(payloads), principal.id],
            );
          }
          await tx.observe([principal.expires]);
          return conflict ? "conflict" : existing ? "existing" : "imported";
        });
      } catch (error) {
        return error instanceof PracticeLifetimeFailure &&
          error.kind === "denied"
          ? "denied"
          : "unavailable";
      }
    },
  };
}
