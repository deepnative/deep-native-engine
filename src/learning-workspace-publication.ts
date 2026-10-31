import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { ContentState, DraftContent } from "./catalog.ts";
import { hash } from "./store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import {
  learningWorkspacePack,
  type LearningWorkspacePack,
} from "./learning-workspace-pack.ts";

type Failure = { kind: "denied" | "conflict" | "unavailable" };
export interface LearningWorkspacePublicationStore {
  import(token: string): Promise<{ kind: "imported" | "existing" } | Failure>;
  preview(token: string): Promise<
    | {
        kind: "ready";
        pack: LearningWorkspacePack;
        state: ContentState | "not-imported";
      }
    | Failure
  >;
}

function fields(item: DraftContent) {
  return {
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
  };
}

/** Import only an ordinary draft. Approval and publication retain the existing
 * distinct-reviewer catalog lifecycle; application startup never calls import. */
export function learningWorkspacePublicationStore(
  pool: Pool,
  load: () => Promise<LearningWorkspacePack> = learningWorkspacePack,
): LearningWorkspacePublicationStore {
  async function run<T>(
    token: string,
    editorOnly: boolean,
    use: (
      tx: PracticeTransaction,
      actor: string,
      pack: LearningWorkspacePack,
      existing: Record<string, unknown> | undefined,
    ) => Promise<T>,
  ): Promise<T | Failure> {
    if (typeof token !== "string" || !token.trim()) return { kind: "denied" };
    try {
      return await practiceTransaction(pool, async (tx) => {
        const actor = (
          await tx.query<{ id: string; expires: Date }>(
            `SELECT id,expires_at AS expires FROM principals WHERE token_hash=$1
           AND kind='staff' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token)],
          )
        ).rows[0];
        if (!actor) throw new PracticeLifetimeFailure("denied");
        await tx.observe([actor.expires]);
        const profile = (
          await tx.query<{ role: string }>(
            "SELECT role FROM staff_profiles WHERE principal_id=$1 FOR SHARE",
            [actor.id],
          )
        ).rows[0];
        if (
          !profile ||
          (editorOnly
            ? profile.role !== "editor"
            : !["editor", "reviewer"].includes(profile.role))
        )
          throw new PracticeLifetimeFailure("denied");
        const pack = await tx.bounded(load);
        await tx.query("SELECT pg_advisory_xact_lock(34,20261029)");
        const rows = (
          await tx.query<Record<string, unknown>>(
            "SELECT * FROM content_versions WHERE id=$1 ORDER BY version FOR SHARE",
            [pack.publication.id],
          )
        ).rows;
        const existing = rows.find(
          (row) => row.version === pack.publication.version,
        );
        const expected = fields(pack.publication);
        if (
          (rows.length > 0 && !existing) ||
          (existing &&
            !Object.entries(expected).every(([key, value]) =>
              isDeepStrictEqual(existing[key], value),
            ))
        ) {
          await tx.observe([actor.expires]);
          return { kind: "conflict" } as Failure;
        }
        const result = await use(tx, actor.id, pack, existing);
        await tx.observe([actor.expires]);
        return result;
      });
    } catch (error) {
      return {
        kind:
          error instanceof PracticeLifetimeFailure && error.kind === "denied"
            ? "denied"
            : "unavailable",
      };
    }
  }
  return {
    import: (token) =>
      run(token, true, async (tx, actor, pack, existing) => {
        if (existing) return { kind: "existing" as const };
        await tx.query(
          `INSERT INTO content_versions
         (id,version,kind,origin,title,body,owner,sources,rights,goals,backgrounds,domains,prerequisites,
          structured_prerequisites,minimum_experience,rubric,rubric_version,requires_qualified_signoff,created_by)
         SELECT id,version,kind,origin,title,body,owner,sources,rights,goals,backgrounds,domains,prerequisites,
          structured_prerequisites,minimum_experience,rubric,rubric_version,requires_qualified_signoff,$2::uuid
         FROM jsonb_to_record($1::jsonb) AS x(id text,version integer,kind text,origin text,title text,
          body text,owner text,sources text,rights text,goals text[],backgrounds text[],domains text[],prerequisites text,
          structured_prerequisites jsonb,minimum_experience text,rubric text,rubric_version integer,requires_qualified_signoff boolean)`,
          [JSON.stringify(fields(pack.publication)), actor],
        );
        return { kind: "imported" as const };
      }),
    preview: (token) =>
      run(token, false, async (_tx, _actor, pack, existing) => ({
        kind: "ready" as const,
        pack,
        state: existing
          ? (existing.state as ContentState)
          : ("not-imported" as const),
      })),
  };
}
