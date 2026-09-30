import type { Pool } from "pg";
import type { ContentVersion } from "./catalog.ts";
import {
  effectivePrerequisiteSpec,
  type PrerequisiteAtom,
} from "./prerequisites.ts";
import { hash } from "./store.ts";

export interface ReadinessAction {
  kind: "lesson" | "exercise";
  contentId: string;
  contentVersion: number;
}
export interface ReadinessRequirement {
  kind: "lesson" | "exercise" | "unavailable";
  contentId?: string;
  contentVersion?: number;
  title?: string;
  required?: "started" | "self-assessed" | "completed";
  observed:
    "not-started" | "started" | "self-assessed" | "completed" | "unavailable";
  satisfied: boolean;
  detailsLimited?: true;
  action?: ReadinessAction;
  requirements: ReadinessRequirement[];
}
export interface AssignmentReadiness {
  contentId: string;
  contentVersion: number;
  title: string;
  eligible: boolean;
  requirements: ReadinessRequirement[];
}
export interface AssignmentReadinessStore {
  list(token: string): Promise<AssignmentReadiness[] | null>;
  get(
    token: string,
    id: string,
    version: number,
  ): Promise<AssignmentReadiness | null>;
}
export function disabledAssignmentReadinessStore(): AssignmentReadinessStore {
  return { list: async () => [], get: async () => null };
}

type SafeContent = Pick<
  ContentVersion,
  | "id"
  | "version"
  | "kind"
  | "title"
  | "prerequisites"
  | "structuredPrerequisites"
> & {
  matchesAudience: boolean;
  eligible: boolean;
  prerequisitesSatisfied: boolean;
};
interface ObservedLesson {
  contentId: string;
  contentVersion: number;
  startedAt: Date | null;
  selfAssessedAt: Date | null;
}
const unavailable = (): ReadinessRequirement => ({
  kind: "unavailable",
  observed: "unavailable",
  satisfied: false,
  requirements: [],
});

function explain(
  item: SafeContent,
  catalog: SafeContent[],
  activity: ObservedLesson[],
  completed: boolean,
): ReadinessRequirement[] {
  const requirementMet = (atom: PrerequisiteAtom): boolean => {
    if (atom.kind === "exercise") return completed;
    const source = catalog.find(
      (candidate) =>
        candidate.kind === "lesson" &&
        candidate.id === atom.id &&
        candidate.version === atom.version,
    );
    const observed = activity.find(
      (entry) =>
        entry.contentId === atom.id && entry.contentVersion === atom.version,
    );
    return Boolean(
      source?.prerequisitesSatisfied &&
      (atom.activity === "started"
        ? observed?.startedAt
        : observed?.selfAssessedAt),
    );
  };
  let budget = 256;
  const expanded = new Set<string>();
  function visit(
    source: SafeContent,
    path: ReadonlySet<string>,
  ): ReadinessRequirement[] {
    const identity = `${source.id}:${source.version}`;
    if (path.has(identity) || path.size > 32) return [unavailable()];
    budget--;
    expanded.add(identity);
    const spec = effectivePrerequisiteSpec(
      source.structuredPrerequisites,
      source.prerequisites,
    );
    if (!spec) return [unavailable()];
    const next = new Set(path).add(identity);
    // Spend bounded presentation on unmet work first. A large completed branch
    // must not hide the only actionable leaf at the end of an authored graph.
    const prioritized = [...spec.all].sort(
      (a, b) => Number(requirementMet(a)) - Number(requirementMet(b)),
    );
    return prioritized.map((atom): ReadinessRequirement => {
      if (atom.kind === "exercise")
        return {
          kind: "exercise",
          contentId: atom.id,
          contentVersion: atom.version,
          title: "Local clear-instructions exercise",
          required: "completed",
          observed: completed ? "completed" : "not-started",
          satisfied: completed,
          ...(!completed
            ? {
                action: {
                  kind: "exercise" as const,
                  contentId: atom.id,
                  contentVersion: atom.version,
                },
              }
            : {}),
          requirements: [],
        };
      const lesson = catalog.find(
        (candidate) =>
          candidate.kind === "lesson" &&
          candidate.id === atom.id &&
          candidate.version === atom.version,
      );
      if (!lesson || next.has(`${atom.id}:${atom.version}`))
        return unavailable();
      const observed = activity.find(
        (entry) =>
          entry.contentId === atom.id && entry.contentVersion === atom.version,
      );
      const state = observed?.selfAssessedAt
        ? "self-assessed"
        : observed?.startedAt
          ? "started"
          : "not-started";
      const satisfied =
        (atom.activity === "started"
          ? Boolean(observed?.startedAt)
          : Boolean(observed?.selfAssessedAt)) && lesson.prerequisitesSatisfied;
      if (!satisfied && !lesson.matchesAudience) return unavailable();
      // Repeated shared DAG nodes and the display budget limit presentation,
      // never the authoritative observed prerequisite result.
      const detailsLimited =
        expanded.has(`${atom.id}:${atom.version}`) || budget <= 0;
      const requirements = detailsLimited ? [] : visit(lesson, next);
      return {
        kind: "lesson",
        contentId: atom.id,
        contentVersion: atom.version,
        title: lesson.title,
        required: atom.activity,
        observed: state,
        satisfied,
        ...(detailsLimited ? { detailsLimited: true as const } : {}),
        ...(!satisfied && lesson.eligible
          ? {
              action: {
                kind: "lesson" as const,
                contentId: atom.id,
                contentVersion: atom.version,
              },
            }
          : {}),
        requirements,
      };
    });
  }
  return visit(item, new Set());
}

export function assignmentReadinessStore(pool: Pool): AssignmentReadinessStore {
  async function snapshot(
    token: string,
  ): Promise<AssignmentReadiness[] | null> {
    try {
      const client = await pool.connect();
      try {
        // Prerequisite SQL takes FOR SHARE locks, so a READ ONLY transaction is
        // incompatible. This transaction performs no application-data writes.
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        const owner = (
          await client.query<{ id: string }>(
            `SELECT l.id FROM principals p JOIN learners l ON l.id=p.id
          JOIN workspaces w ON w.owner_principal_id=p.id
          WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
            AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL
          FOR SHARE OF p`,
            [hash(token)],
          )
        ).rows[0];
        if (!owner) return null;
        // Match starter-save/deletion ordering: principal, workspace, learner.
        const workspace = await client.query(
          "SELECT id FROM workspaces WHERE id=$1 AND deleting_at IS NULL FOR SHARE",
          [owner.id],
        );
        if (!workspace.rows[0]) return null;
        const learner = await client.query(
          "SELECT id FROM learners WHERE id=$1 FOR SHARE",
          [owner.id],
        );
        if (!learner.rows[0]) return null;
        // Current local curated publication is the existing synthetic corpus
        // boundary. An ID prefix is not evidence of provenance. Never read or
        // expose draft, qualified-pending, retired or superseded source metadata.
        const catalog = (
          await client.query<SafeContent>(
            `SELECT cv.id,cv.version,cv.kind,cv.title,cv.prerequisites,
          cv.structured_prerequisites AS "structuredPrerequisites",
          ((cardinality(cv.goals)=0 OR l.goal=ANY(cv.goals))
            AND (cardinality(cv.backgrounds)=0 OR l.background=ANY(cv.backgrounds) OR cv.backgrounds && l.background_tags)
            AND (cardinality(cv.domains)=0 OR cv.domains && l.domain_tags)
            AND array_position(ARRAY['new','some','experienced'],COALESCE(l.experience,'new'))
              >= array_position(ARRAY['new','some','experienced'],cv.minimum_experience)) AS "matchesAudience",
          member_content_eligible(l.id,cv.id,cv.version) AS eligible,
          member_prerequisites_met(l.id,cv.id,cv.version) AS "prerequisitesSatisfied"
          FROM content_versions cv CROSS JOIN learners l
          WHERE l.id=$1 AND cv.kind IN ('assignment','lesson') AND cv.origin='curated'
            AND cv.state='published' AND NOT cv.requires_qualified_signoff
            AND NOT EXISTS(SELECT 1 FROM content_versions newer WHERE newer.id=cv.id
              AND newer.version>cv.version AND newer.published_at IS NOT NULL)
          ORDER BY cv.id,cv.version`,
            [owner.id],
          )
        ).rows;
        const progress = (
          await client.query<{ completed_at: Date | null }>(
            `SELECT max(completed_at) AS completed_at FROM exercises
          WHERE learner_id=$1 AND workspace_id=$1 AND lesson_id='clear-instructions' AND lesson_version=1`,
            [owner.id],
          )
        ).rows[0];
        const activity = (
          await client.query<ObservedLesson>(
            `SELECT content_id AS "contentId",content_version AS "contentVersion",
          started_at AS "startedAt",self_assessed_at AS "selfAssessedAt" FROM lesson_activity WHERE member_id=$1`,
            [owner.id],
          )
        ).rows;
        const result = catalog
          .filter((item) => item.kind === "assignment" && item.matchesAudience)
          .map((item) => ({
            contentId: item.id,
            contentVersion: item.version,
            title: item.title,
            eligible: item.eligible,
            requirements: explain(
              item,
              catalog,
              activity,
              Boolean(progress?.completed_at),
            ),
          }));
        const current = await client.query(
          "SELECT id FROM principals WHERE id=$1 AND expires_at>clock_timestamp()",
          [owner.id],
        );
        if (!current.rows[0]) return null;
        await client.query("COMMIT");
        return result;
      } finally {
        let rollbackError: Error | undefined;
        try {
          await client.query("ROLLBACK");
        } catch {
          rollbackError = new Error("Assignment readiness rollback failed");
        }
        client.release(rollbackError);
      }
    } catch {
      return null;
    }
  }
  return {
    list: snapshot,
    async get(token, id, version) {
      if (
        !/^[A-Z]{2,5}-[0-9]{3}$/.test(id) ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version > 2147483647
      )
        return null;
      const items = await snapshot(token);
      return (
        items?.find(
          (item) => item.contentId === id && item.contentVersion === version,
        ) ?? null
      );
    },
  };
}
