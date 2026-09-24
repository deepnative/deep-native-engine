import type { Pool } from "pg";
import { hash } from "./store.ts";

export interface PreviewMetrics {
  scope: "synthetic-local-preview";
  asOf: Date;
  definitions: {
    denominator: string;
    activated: string;
    selfAssessed: string;
    participated: string;
    activeCircle: string;
  };
  counts: {
    members: number;
    activated: number;
    selfAssessed: number;
    participated: number;
    activeCircle: number;
  };
}

export interface MetricsStore {
  snapshot(token: string): Promise<PreviewMetrics | null>;
}

export function disabledMetricsStore(): MetricsStore {
  return { snapshot: async () => null };
}

export function metricsStore(pool: Pool): MetricsStore {
  return {
    async snapshot(token) {
      const result = await pool.query<{
        asOf: Date;
        members: number;
        activated: number;
        selfAssessed: number;
        participated: number;
        activeCircle: number;
      }>(
        `WITH authorized AS (
           SELECT 1 FROM principals p JOIN staff_profiles s ON s.principal_id=p.id
           WHERE p.token_hash=$1 AND p.kind='staff'
             AND s.role IN ('operator','platform_admin')
             AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP
         ), member_events AS (
           SELECT l.id,
             EXISTS(SELECT 1 FROM lesson_activity a WHERE a.member_id=l.id) AS activated,
             EXISTS(SELECT 1 FROM lesson_activity a WHERE a.member_id=l.id
               AND a.self_assessed_at IS NOT NULL) AS self_assessed,
             EXISTS(SELECT 1 FROM preview_circle_memberships c WHERE c.member_id=l.id)
               AS participated,
             EXISTS(SELECT 1 FROM preview_circle_memberships c WHERE c.member_id=l.id
               AND c.left_at IS NULL) AS active_circle
           FROM learners l WHERE EXISTS(SELECT 1 FROM authorized)
         )
         SELECT CURRENT_TIMESTAMP AS "asOf",COUNT(*)::integer AS members,
           COUNT(*) FILTER(WHERE activated)::integer AS activated,
           COUNT(*) FILTER(WHERE self_assessed)::integer AS "selfAssessed",
           COUNT(*) FILTER(WHERE participated)::integer AS participated,
           COUNT(*) FILTER(WHERE active_circle)::integer AS "activeCircle"
         FROM member_events HAVING EXISTS(SELECT 1 FROM authorized)`,
        [hash(token)],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        scope: "synthetic-local-preview",
        asOf: row.asOf,
        definitions: {
          denominator:
            "Current retained local-preview member records at asOf; deleted members cannot be reconstructed. Expired and revoked sessions remain included.",
          activated:
            "Distinct members with at least one versioned lesson open, divided by members. Opening does not establish learning.",
          selfAssessed:
            "Distinct members with at least one self-assessed lesson completion, divided by members. This is not observed skill or formal assessment.",
          participated:
            "Distinct members who ever joined a local circle, divided by members. Leaving does not remove them from this numerator.",
          activeCircle:
            "Distinct members with a local circle membership whose left_at is empty, divided by members. No shared community or clinic is implied.",
        },
        counts: {
          members: row.members,
          activated: row.activated,
          selfAssessed: row.selfAssessed,
          participated: row.participated,
          activeCircle: row.activeCircle,
        },
      };
    },
  };
}
