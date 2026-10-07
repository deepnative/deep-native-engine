import { workflowReviewCursor } from "./workflow-review-cursor.ts";
import type { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { workflowBundle } from "./workflow-registry.ts";
import { reviewActors, reviewExecute } from "./workflow-review-transaction.ts";
interface Candidate {
  id: string;
  requestId: string;
  memberId: string;
  moderatorId: string;
  administratorId: string;
  instanceId: string;
  revision: number;
  workflowId: string;
  workflowVersion: number;
  workspaceId: string;
  createdAt: string;
}
const projection = `g.id,g.request_id AS "requestId",r.member_id AS "memberId",g.moderator_id AS "moderatorId",g.administrator_id AS "administratorId",
 g.source_instance_id AS "instanceId",g.source_revision AS revision,r.workflow_id AS "workflowId",r.workflow_version AS "workflowVersion",g.workspace_id AS "workspaceId",
 to_char(g.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;
export function workflowReviewWorklist(pool: Pool, secret: string) {
  const codec = workflowReviewCursor(secret, "worklist");
  return async (token: string, cursor?: string) => {
    const after = cursor === undefined ? null : codec.read(cursor);
    if (cursor !== undefined && !after) return { kind: "invalid" as const };
    return reviewExecute(pool, token, false, async (c) => {
      if (after && after.actorId !== c.actorId)
        return { kind: "denied" as const };
      // Discovery is bounded and contains metadata only. Its identity set is
      // locked together before any per-row permission projection.
      const candidates = (
        await c.tx.query<Candidate>(
          `SELECT ${projection} FROM workflow_review_grants g JOIN workflow_review_requests r ON r.id=g.request_id
    WHERE g.moderator_id=$1 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND r.withdrawn_at IS NULL AND r.expires_at>clock_timestamp()
    AND ($2::timestamptz IS NULL OR (g.created_at,g.id)>($2::timestamptz,$3::uuid)) ORDER BY g.created_at,g.id LIMIT 21`,
          [c.actorId, after?.createdAt ?? null, after?.id ?? null],
        )
      ).rows;
      await reviewActors(
        c,
        candidates.flatMap((r) => [r.memberId, r.administratorId]),
        "moderator",
      );
      const scanned = candidates.slice(0, 20);
      const workspaceIds = [
        ...new Set(scanned.map((r) => r.workspaceId)),
      ].sort();
      await c.tx.query(
        `SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [workspaceIds],
      );
      await c.tx.query(
        `SELECT instance_id FROM workflow_feedback WHERE instance_id=ANY($1::uuid[]) ORDER BY member_id,workflow_id,workflow_version FOR SHARE`,
        [scanned.map((r) => r.instanceId)],
      );
      await c.tx.query(
        `SELECT id FROM workflow_review_requests WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [scanned.map((r) => r.requestId)],
      );
      await c.tx.query(
        `SELECT id FROM workflow_review_grants WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [scanned.map((r) => r.id)],
      );
      const current = (
        await c.tx.query<
          Candidate & { expires: Date; starts: Date; authorityExpires: Date }
        >(
          `SELECT ${projection},g.starts_at AS starts,g.expires_at AS expires,
    LEAST(g.expires_at,r.expires_at,owner.expires_at,admin.expires_at,mod.expires_at) AS "authorityExpires"
    FROM workflow_review_grants g JOIN workflow_review_requests r ON r.id=g.request_id
    JOIN workspaces w ON w.id=g.workspace_id AND w.id=r.workspace_id AND w.owner_principal_id=r.member_id AND w.deleting_at IS NULL
    JOIN workflow_feedback f ON f.member_id=r.member_id AND f.instance_id=g.source_instance_id AND f.instance_id=r.source_instance_id
      AND f.revision=g.source_revision AND f.revision=r.source_revision AND f.workflow_id=r.workflow_id AND f.workflow_version=r.workflow_version
    JOIN principals owner ON owner.id=r.member_id AND owner.kind='member' AND owner.revoked_at IS NULL AND owner.expires_at>clock_timestamp()
    JOIN principals admin ON admin.id=g.administrator_id AND admin.kind='staff' AND admin.revoked_at IS NULL AND admin.expires_at>clock_timestamp()
    JOIN staff_profiles ap ON ap.principal_id=admin.id AND ap.role='platform_admin'
    JOIN principals mod ON mod.id=g.moderator_id AND mod.kind='staff' AND mod.revoked_at IS NULL AND mod.expires_at>clock_timestamp()
    JOIN staff_profiles mp ON mp.principal_id=mod.id AND mp.role='moderator'
    WHERE g.id=ANY($1::uuid[]) AND g.moderator_id=$2 AND g.revoked_at IS NULL AND r.withdrawn_at IS NULL
      AND g.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp() ORDER BY g.created_at,g.id`,
          [scanned.map((r) => r.id), c.actorId],
        )
      ).rows;
      const entries = [];
      for (const row of current) {
        const { expires, starts, authorityExpires, ...identity } = row;
        if (
          !isDeepStrictEqual(
            identity,
            scanned.find((r) => r.id === row.id),
          )
        )
          continue;
        const bundle = await c.tx.bounded(() => workflowBundle(row.workflowId));
        if (!bundle || bundle.version !== row.workflowVersion) continue;
        c.expires.push(authorityExpires);
        entries.push({
          grantId: row.id,
          workflowId: row.workflowId,
          workflowVersion: row.workflowVersion,
          revision: row.revision,
          startsAt: starts.toISOString(),
          expiresAt: expires.toISOString(),
        });
      }
      await c.tx.observe(c.expires);
      const last = scanned.at(-1);
      return {
        kind: "ready" as const,
        entries,
        next:
          candidates.length > 20 && last
            ? codec.sign({
                actorId: c.actorId,
                createdAt: last.createdAt,
                id: last.id,
              })
            : null,
      };
    });
  };
}
