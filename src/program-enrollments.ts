import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, QueryResult, QueryResultRow } from "pg";
import { hash } from "./store.ts";
import { reviewedFoundation } from "./foundation-pack.ts";
import type { DraftContent } from "./catalog.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
  type PracticeTransaction,
} from "./practice-session-lifetime.ts";
import {
  PROGRAM_DIGEST,
  PROGRAM_MANIFEST,
  programIntent,
  programKey,
  type ProgramOverview,
  type ProgramReceipt,
  type ProgramResult,
  type ProgramState,
  type ProgramStore,
} from "./program-values.ts";

interface Reader {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}
interface Term extends QueryResultRow {
  snapshot: unknown;
  digest: string;
  state: ProgramState;
  revision: number;
  enrolled: number;
  content: Array<Record<string, unknown>>;
}
interface Context {
  tx: PracticeTransaction;
  principalId: string;
  workspaceId: string;
  expires: Date;
}
const unavailable = () => new PracticeLifetimeFailure("unavailable");
const termQuery = `SELECT t.snapshot,t.digest,t.state,t.revision,
 (SELECT count(*)::integer FROM local_program_enrollments) AS enrolled,
 COALESCE((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('current',
   NOT EXISTS(SELECT 1 FROM content_versions n WHERE n.id=c.id
    AND n.version>c.version AND n.published_at IS NOT NULL)) ORDER BY c.id)
  FROM content_versions c WHERE c.id=ANY($1::text[]) AND c.version=2),'[]'::jsonb) AS content
 FROM local_program_terms t WHERE t.id='local-foundation-1'`;
const ids = PROGRAM_MANIFEST.lessons.map((lesson) => lesson.id);

async function term(reader: Reader): Promise<Term> {
  const row = (await reader.query<Term>(termQuery, [ids])).rows[0];
  if (
    !row ||
    !isDeepStrictEqual(row.snapshot, PROGRAM_MANIFEST) ||
    row.digest !== PROGRAM_DIGEST ||
    !["not_open", "open", "closed"].includes(row.state) ||
    row.revision !== { not_open: 1, open: 2, closed: 3 }[row.state] ||
    !Number.isInteger(row.enrolled) ||
    row.enrolled < 0 ||
    row.enrolled > PROGRAM_MANIFEST.capacity ||
    !Array.isArray(row.content)
  )
    throw unavailable();
  return row;
}
function sourceReady(row: Term, pack: DraftContent[]) {
  return (
    row.content.length === pack.length &&
    pack.every((item) => {
      const c = row.content.find((candidate) => candidate.id === item.id);
      const expected = {
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
      };
      return (
        c?.state === "published" &&
        c.current === true &&
        c.rights_confirmed === true &&
        c.requires_qualified_signoff === false &&
        c.reviewed_at !== null &&
        c.published_at !== null &&
        Object.entries(expected).every(([key, value]) =>
          isDeepStrictEqual(c[key], value),
        )
      );
    })
  );
}
function overview(row: Term, pack: DraftContent[]): ProgramOverview {
  return {
    manifest: structuredClone(PROGRAM_MANIFEST),
    digest: row.digest,
    revision: row.revision,
    state: row.state,
    availability: !sourceReady(row, pack)
      ? "course_unavailable"
      : row.state !== "open"
        ? row.state
        : row.enrolled >= PROGRAM_MANIFEST.capacity
          ? "full"
          : "ready",
    remaining: PROGRAM_MANIFEST.capacity - row.enrolled,
    lessons: pack.map(({ id, version, title }) => ({ id, version, title })),
  };
}
export function programEnrollmentStore(
  pool: Pool,
  mode: "demo" | "test" | "live",
): ProgramStore {
  const enabled = mode === "demo" || mode === "test";
  async function run<T>(
    token: string,
    staff: boolean,
    use: (context: Context) => Promise<ProgramResult<T>>,
  ): Promise<ProgramResult<T>> {
    if (!enabled || !/^[a-f0-9]{64}$/.test(token)) return { kind: "denied" };
    try {
      return await practiceTransaction(pool, async (tx) => {
        const actor = (
          await tx.query<{ id: string; expires: Date }>(
            `SELECT id,expires_at AS expires FROM principals
             WHERE token_hash=$1 AND kind=$2 AND revoked_at IS NULL
              AND expires_at>clock_timestamp() FOR SHARE`,
            [hash(token), staff ? "staff" : "member"],
          )
        ).rows[0];
        if (!actor) throw new PracticeLifetimeFailure("denied");
        await tx.observe([actor.expires]);
        let workspaceId = "";
        if (staff) {
          const role = (
            await tx.query<{ role: string }>(
              "SELECT role FROM staff_profiles WHERE principal_id=$1 FOR SHARE",
              [actor.id],
            )
          ).rows[0];
          if (role?.role !== "platform_admin")
            throw new PracticeLifetimeFailure("denied");
        } else {
          const workspace = (
            await tx.query<{ id: string }>(
              `SELECT id FROM workspaces WHERE owner_principal_id=$1
               AND deleting_at IS NULL FOR SHARE`,
              [actor.id],
            )
          ).rows[0];
          if (!workspace) throw new PracticeLifetimeFailure("denied");
          workspaceId = workspace.id;
        }
        const result = await use({
          tx,
          principalId: actor.id,
          workspaceId,
          expires: actor.expires,
        });
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
  async function receipt(
    ctx: Context,
    key?: string,
  ): Promise<ProgramReceipt | null> {
    const found = (
      await ctx.tx.query<{
        id: string;
        enrolled: Date;
        snapshot: unknown;
        digest: string;
      }>(
        `SELECT e.id,e.enrolled_at AS enrolled,t.snapshot,t.digest
         FROM local_program_enrollments e JOIN local_program_terms t ON t.id=e.term_id
         WHERE e.workspace_id=$1 AND ($2::uuid IS NULL OR e.idempotency_key=$2)`,
        [ctx.workspaceId, key ?? null],
      )
    ).rows;
    if (found.length > 1) throw unavailable();
    const row = found[0];
    if (!row) return null;
    if (
      !(row.enrolled instanceof Date) ||
      !Number.isFinite(+row.enrolled) ||
      !isDeepStrictEqual(row.snapshot, PROGRAM_MANIFEST) ||
      row.digest !== PROGRAM_DIGEST
    )
      throw unavailable();
    const activity = (
      await ctx.tx.query<{
        id: string;
        version: number;
        started: boolean;
        selfAssessed: boolean;
      }>(
        `SELECT content_id AS id,content_version AS version,
          started_at IS NOT NULL AS started,self_assessed_at IS NOT NULL AS "selfAssessed"
         FROM lesson_activity WHERE member_id=$1 AND content_id=ANY($2::text[])
          AND content_version=2 ORDER BY content_id`,
        [ctx.principalId, ids],
      )
    ).rows;
    return {
      id: row.id,
      enrolledAt: row.enrolled.toISOString(),
      manifest: structuredClone(PROGRAM_MANIFEST),
      digest: row.digest,
      activity,
    };
  }
  const readOverview = async (reader: Reader) => {
    const pack = await reviewedFoundation();
    return overview(await term(reader), pack);
  };
  return {
    async overview() {
      if (!enabled) return { kind: "unavailable" };
      try {
        return { kind: "ready", value: await readOverview(pool) };
      } catch {
        return { kind: "unavailable" };
      }
    },
    admin(token) {
      return run(token, true, async (ctx) => ({
        kind: "ready",
        value: await ctx.tx.bounded(() => readOverview(ctx.tx)),
      }));
    },
    change(token, action, revision, digest) {
      if (
        !["open", "close"].includes(action) ||
        !Number.isSafeInteger(revision) ||
        digest !== PROGRAM_DIGEST
      )
        return Promise.resolve({ kind: "invalid" });
      return run<ProgramOverview>(token, true, async (ctx) => {
        const pack = await ctx.tx.bounded(reviewedFoundation);
        if (action === "open")
          await ctx.tx.query("LOCK TABLE content_versions IN SHARE MODE");
        await ctx.tx.query(
          "SELECT id FROM local_program_terms WHERE id='local-foundation-1' FOR UPDATE",
        );
        const row = await term(ctx.tx);
        if (row.revision !== revision) return { kind: "stale" };
        if (
          (action === "open" && row.state !== "not_open") ||
          (action === "close" && row.state !== "open")
        )
          return { kind: "closed" };
        if (action === "open" && !sourceReady(row, pack))
          return { kind: "stale" };
        await ctx.tx.observe([ctx.expires]);
        await ctx.tx.query(
          `UPDATE local_program_terms SET state=$1,revision=revision+1
           WHERE id='local-foundation-1' AND revision=$2`,
          [action === "open" ? "open" : "closed", revision],
        );
        return { kind: "ready", value: overview(await term(ctx.tx), pack) };
      });
    },
    enroll(token, key, submitted) {
      const intent = programIntent(submitted);
      if (!programKey(key) || !intent)
        return Promise.resolve({ kind: "invalid" });
      return run<ProgramReceipt>(token, false, async (ctx) => {
        const pack = await ctx.tx.bounded(reviewedFoundation);
        await ctx.tx.query("LOCK TABLE content_versions IN SHARE MODE");
        await ctx.tx.query(
          "SELECT id FROM local_program_terms WHERE id='local-foundation-1' FOR UPDATE",
        );
        const row = await term(ctx.tx);
        const exact =
          intent.programVersion === PROGRAM_MANIFEST.programVersion &&
          intent.termVersion === PROGRAM_MANIFEST.termVersion &&
          intent.digest === PROGRAM_DIGEST;
        const prior = await receipt(ctx);
        if (prior)
          return exact ? { kind: "ready", value: prior } : { kind: "conflict" };
        if (
          !exact ||
          row.revision !== intent.revision ||
          !sourceReady(row, pack)
        )
          return { kind: "stale" };
        if (row.state !== "open") return { kind: "closed" };
        if (row.enrolled >= PROGRAM_MANIFEST.capacity) return { kind: "full" };
        await ctx.tx.observe([ctx.expires]);
        await ctx.tx.query(
          `INSERT INTO local_program_enrollments(id,workspace_id,term_id,idempotency_key,fingerprint)
           VALUES($1,$2,'local-foundation-1',$3,$4)`,
          [randomUUID(), ctx.workspaceId, key, PROGRAM_DIGEST],
        );
        const saved = await receipt(ctx);
        if (!saved) throw unavailable();
        return { kind: "ready", value: saved };
      });
    },
    mine(token) {
      return run(token, false, async (ctx) => ({
        kind: "ready",
        value: await receipt(ctx),
      }));
    },
    inspect(token, key) {
      if (!programKey(key)) return Promise.resolve({ kind: "invalid" });
      return run(token, false, async (ctx) => ({
        kind: "ready",
        value: await receipt(ctx, key),
      }));
    },
  };
}
