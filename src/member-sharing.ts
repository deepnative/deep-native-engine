import type { Pool } from "pg";
import { CIRCLES, type CircleDefinition } from "./circles.ts";
import { CIRCLE_DISCUSSION_POLICY } from "./circle-discussion.ts";
import { hash } from "./store.ts";

export type SharedCircle = {
  id: string;
  title: string;
  sharing: boolean;
  readablePosts: number;
};
export type SharingSummary = {
  circles: SharedCircle[];
  evidence: number;
  workflowReviews: number;
  eventPermissions: number;
  openSupport: number;
  publishedContributions: number;
  coaches: number;
};
export type SharingResult =
  { kind: "ready"; value: SharingSummary } | { kind: "denied" | "unavailable" };
export interface MemberSharing {
  summary(memberToken: string): Promise<SharingResult>;
}

// A departed or deleting member has no page, the same as every owned read.
const COUNTS = `SELECT p.id AS member,
  (SELECT count(*)::integer FROM evidence_objects e
    WHERE e.owner_principal_id=p.id AND e.private_review_allowed
      AND e.quarantine_state<>'deleting') AS evidence,
  (SELECT count(*)::integer FROM workflow_review_requests r
    WHERE r.member_id=p.id AND r.withdrawn_at IS NULL
      AND r.expires_at>clock_timestamp()) AS "workflowReviews",
  (SELECT count(*)::integer FROM private_event_attendance_permissions a
    WHERE a.member_id=p.id AND a.withdrawn_at IS NULL
      AND a.expires_at>clock_timestamp()) AS "eventPermissions",
  (SELECT count(*)::integer FROM support_requests s
    WHERE s.member_id=p.id AND s.resolved_at IS NULL
      AND s.withdrawn_at IS NULL) AS "openSupport",
  (SELECT count(*)::integer FROM proposal_publications u
    WHERE u.member_id=p.id AND u.state='published') AS "publishedContributions",
  (SELECT count(*)::integer FROM coach_assignments c
    WHERE c.learner_id=p.id) AS coaches
 FROM principals p
 JOIN workspaces w ON w.owner_principal_id=p.id AND w.deleting_at IS NULL
 WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
   AND p.expires_at>clock_timestamp() LIMIT 1`;

// The same rule peers read by: a post shows only under its author's current
// choice, and a reply only while its question's author still shares it.
const JOINED = `SELECT m.circle_id AS id,c.id IS NOT NULL AS sharing,
  (SELECT count(*)::integer FROM preview_circle_posts o
    WHERE c.id IS NOT NULL AND o.member_id=m.member_id AND o.circle_id=m.circle_id
      AND o.choice_id=c.id AND o.state='visible'
      AND (o.root_id IS NULL OR EXISTS(
        SELECT 1 FROM preview_circle_posts r
        JOIN principals rp ON rp.id=r.member_id AND rp.kind='member'
          AND rp.revoked_at IS NULL AND rp.expires_at>clock_timestamp()
        JOIN workspaces rw ON rw.owner_principal_id=r.member_id AND rw.deleting_at IS NULL
        JOIN preview_circle_choices rc ON rc.id=r.choice_id AND rc.member_id=r.member_id
          AND rc.circle_id=r.circle_id AND rc.policy_version=$2 AND rc.revoked_at IS NULL
        JOIN preview_circle_memberships rm ON rm.member_id=r.member_id
          AND rm.circle_id=r.circle_id AND rm.generation=rc.generation AND rm.left_at IS NULL
        WHERE r.id=o.root_id AND r.circle_id=o.circle_id AND r.root_id IS NULL
          AND r.state='visible'))) AS "readablePosts"
 FROM preview_circle_memberships m
 LEFT JOIN preview_circle_choices c ON c.member_id=m.member_id
   AND c.circle_id=m.circle_id AND c.generation=m.generation
   AND c.policy_version=$2 AND c.revoked_at IS NULL
 WHERE m.member_id=$1 AND m.left_at IS NULL ORDER BY m.circle_id`;

/** #40 WHOSEES: a read-only summary of what this member shares right now. */
export function memberSharingStore(pool: Pool): MemberSharing {
  return {
    async summary(memberToken) {
      if (!/^[a-f0-9]{64}$/.test(memberToken)) return { kind: "denied" };
      try {
        const counts = await pool.query<
          Omit<SharingSummary, "circles"> & { member: string }
        >(COUNTS, [hash(memberToken)]);
        const found = counts.rows[0];
        if (!found) return { kind: "denied" };
        const { member, ...value } = found;
        const joined = await pool.query<{
          id: string;
          sharing: boolean;
          readablePosts: number;
        }>(JOINED, [member, CIRCLE_DISCUSSION_POLICY]);
        const circles = (CIRCLES as CircleDefinition[]).flatMap((circle) =>
          joined.rows
            .filter((row) => row.id === circle.id)
            .map((row) => ({ ...row, title: circle.title })),
        );
        return { kind: "ready", value: { ...value, circles } };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
