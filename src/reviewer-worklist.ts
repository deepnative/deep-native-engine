import { randomBytes } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { hash } from "./store.ts";
import {
  sampleToken,
  SAMPLE_FEEDBACK_PURPOSE,
} from "./sample-feedback-values.ts";
import {
  SampleFeedbackFailure,
  sampleFeedbackTransaction,
} from "./sample-feedback-lifetime.ts";
import {
  reviewerWorklistCursor,
  type ReviewerWorklistView,
} from "./reviewer-worklist-cursor.ts";
export type ReviewerWorkState =
  "not-started" | "draft" | "published" | "clarification-needed";
export interface ReviewerWorkItem {
  evidenceId: string;
  title: string;
  version: number;
  submittedAt: string;
  ageMinutes: number;
  state: ReviewerWorkState;
}
export type ReviewerWorklistResult =
  | {
      kind: "ready";
      items: ReviewerWorkItem[];
      next: string | null;
      view: ReviewerWorklistView;
    }
  | { kind: "denied" | "invalid" | "unavailable" };
export interface ReviewerWorklistStore {
  list(
    token: string,
    view: ReviewerWorklistView,
    after?: string,
  ): Promise<ReviewerWorklistResult>;
}
interface Candidate extends QueryResultRow {
  id: string;
  evidenceId: string;
  workspaceId: string;
  assignmentId: string;
  grantId: string;
  title: string;
  version: number;
  at: string;
  state: ReviewerWorkState;
  assignmentExpires: Date;
  grantExpires: Date;
}
const stateSql = `CASE WHEN f.id IS NULL THEN 'not-started' WHEN f.published_at IS NULL THEN 'draft'
 WHEN f.clarified_at IS NOT NULL AND f.answered_at IS NULL THEN 'clarification-needed' ELSE 'published' END`;
const selection = `SELECT s.id,e.id AS "evidenceId",w.id AS "workspaceId",selected.assignment_id AS "assignmentId",selected.id AS "grantId",
 e.original_name AS title,e.revision_number AS version,
 to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
 ${stateSql} AS state, selected.assignment_expires AS "assignmentExpires",selected.expires_at AS "grantExpires"
 FROM evidence_review_submissions s JOIN evidence_objects e ON e.id=s.evidence_id AND e.owner_principal_id=s.submitted_by
 JOIN workspaces w ON w.id=e.workspace_id AND w.owner_principal_id=e.owner_principal_id AND w.deleting_at IS NULL
 JOIN LATERAL (SELECT g.id,g.assignment_id,g.expires_at,a.expires_at AS assignment_expires
  FROM assignment_grants a JOIN reviewer_evidence_grants g ON g.assignment_id=a.id
  WHERE a.workspace_id=w.id AND a.staff_id=$1 AND a.staff_role='reviewer' AND a.revoked_at IS NULL
   AND a.starts_at<=clock_timestamp() AND a.expires_at>clock_timestamp()
   AND g.reviewer_id=$1 AND g.submission_id=s.id AND g.purpose=$2 AND g.revoked_at IS NULL
   AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
  ORDER BY a.id,g.id LIMIT 1) selected ON TRUE
 LEFT JOIN private_sample_feedback f ON f.submission_id=s.id AND f.reviewer_id=$1
 WHERE e.private_review_allowed AND e.quarantine_state='clean' AND e.media_type='text/plain'
 AND s.status IN ('queued','reviewed')
 AND (($3='completed' AND (${stateSql})='published') OR ($3='active' AND (${stateSql})<>'published'))`;
const sameKeys = (a: Candidate, b: Candidate) =>
  a.id === b.id &&
  a.evidenceId === b.evidenceId &&
  a.workspaceId === b.workspaceId &&
  a.assignmentId === b.assignmentId &&
  a.grantId === b.grantId;
export function reviewerWorklistStore(
  pool: Pool,
  secret: Buffer = randomBytes(32),
  enabled = true,
): ReviewerWorklistStore {
  const cursor = reviewerWorklistCursor(secret);
  return {
    async list(token, view, after) {
      if (!enabled) return { kind: "unavailable" };
      if (!sampleToken(token)) return { kind: "denied" };
      if (view !== "active" && view !== "completed") return { kind: "invalid" };
      const previous = cursor.decode(token, view, after);
      if (previous === "invalid") return { kind: "invalid" };
      try {
        return await sampleFeedbackTransaction(pool, false, async (tx) => {
          const deny = () => {
            throw new SampleFeedbackFailure("denied");
          };
          const actor = (
            await tx.query<{ id: string; expires: Date }>(
              `SELECT id,expires_at AS expires FROM principals
    WHERE token_hash=$1 AND kind='staff' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
              [hash(token)],
            )
          ).rows[0];
          if (!actor) return deny();
          const expires = [actor.expires];
          if (previous) expires.push(new Date(previous.expires));
          await tx.observe(expires);
          if (
            !(
              await tx.query(
                "SELECT principal_id FROM staff_profiles WHERE principal_id=$1 AND role='reviewer' FOR SHARE",
                [actor.id],
              )
            ).rows.length
          )
            return deny();
          const base = [actor.id, SAMPLE_FEEDBACK_PURPOSE, view];
          const candidates = (
            await tx.query<Candidate>(
              selection +
                `
    AND ($4::timestamptz IS NULL OR (s.created_at,s.id)>($4::timestamptz,$5::uuid))
    ORDER BY s.created_at,s.id LIMIT 21`,
              [...base, previous?.at ?? null, previous?.id ?? null],
            )
          ).rows;
          // Each lock level is bounded by the discovered page and ordered independently.
          const levels: [string, string, string[]][] = [
            ["workspaces", "id", candidates.map((c) => c.workspaceId)],
            ["evidence_objects", "id", candidates.map((c) => c.evidenceId)],
            ["evidence_review_submissions", "id", candidates.map((c) => c.id)],
            ["assignment_grants", "id", candidates.map((c) => c.assignmentId)],
            [
              "reviewer_evidence_grants",
              "id",
              candidates.map((c) => c.grantId),
            ],
          ];
          for (const [table, column, values] of levels) {
            const ids = [...new Set(values)].sort();
            const locked = await tx.query(
              `SELECT ${column} FROM ${table} WHERE ${column}=ANY($1::uuid[]) ORDER BY ${column} FOR SHARE`,
              [ids],
            );
            if (locked.rows.length !== ids.length) return deny();
          }
          const ids = candidates.map((c) => c.id);
          await tx.query(
            `SELECT id FROM private_sample_feedback WHERE submission_id=ANY($1::uuid[]) AND reviewer_id=$2 ORDER BY id FOR SHARE`,
            [ids, actor.id],
          );
          const current = (
            await tx.query<Candidate>(
              selection +
                ` AND s.id=ANY($4::uuid[]) ORDER BY s.created_at,s.id LIMIT 21`,
              [...base, ids],
            )
          ).rows;
          if (
            current.length !== candidates.length ||
            current.some((c, i) => !sameKeys(c, candidates[i]!))
          )
            return deny();
          for (const row of current)
            expires.push(row.assignmentExpires, row.grantExpires);
          await tx.observe(expires);
          const observed = (
            await tx.query<{ at: Date }>("SELECT clock_timestamp() AS at")
          ).rows[0]!.at;
          const emitted = current.slice(0, 20);
          if (emitted.length)
            await tx.query(
              `INSERT INTO private_sample_feedback_audit(id,workspace_id,evidence_id,submission_id,actor_id,assignment_id,exact_grant_id,action)
    SELECT gen_random_uuid(),w,e,s,$1,a,g,'read' FROM unnest($2::uuid[],$3::uuid[],$4::uuid[],$5::uuid[],$6::uuid[]) AS t(w,e,s,a,g)`,
              [
                actor.id,
                emitted.map((c) => c.workspaceId),
                emitted.map((c) => c.evidenceId),
                emitted.map((c) => c.id),
                emitted.map((c) => c.assignmentId),
                emitted.map((c) => c.grantId),
              ],
            );
          await tx.observe(expires);
          const last = emitted.at(-1);
          return {
            kind: "ready" as const,
            view,
            items: emitted.map((c) => ({
              evidenceId: c.evidenceId,
              title: c.title,
              version: c.version,
              submittedAt: c.at,
              ageMinutes: Math.max(
                0,
                Math.floor((+observed - Date.parse(c.at)) / 60000),
              ),
              state: c.state,
            })),
            next:
              current.length > 20 && last
                ? cursor.encode(
                    token,
                    view,
                    { at: last.at, id: last.id },
                    previous?.expires,
                  )
                : null,
          };
        });
      } catch (error) {
        return {
          kind:
            error instanceof SampleFeedbackFailure && error.kind === "denied"
              ? "denied"
              : "unavailable",
        };
      }
    },
  };
}
