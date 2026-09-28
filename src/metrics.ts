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
    submittedAssignment: string;
    returnEligible: string;
    crossContentReturned: string;
    usefulness: string;
  };
  counts: {
    members: number;
    activated: number;
    selfAssessed: number;
    participated: number;
    activeCircle: number;
    submittedAssignment: number;
    returnEligible: number;
    crossContentReturned: number;
  };
  usefulness: UsefulnessDisclosure;
}

export interface UsefulnessDisclosure {
  disclosure: "suppressed" | "coarse-band";
  helpfulShareBand: "0-24%" | "25-49%" | "50-74%" | "75-100%" | null;
}

export function usefulnessDisclosure(
  respondents: number,
  helpful: number,
  notYet: number,
): UsefulnessDisclosure {
  if (
    !Number.isSafeInteger(respondents) ||
    !Number.isSafeInteger(helpful) ||
    !Number.isSafeInteger(notYet) ||
    respondents < 20 ||
    helpful < 5 ||
    notYet < 5 ||
    helpful + notYet !== respondents
  )
    return { disclosure: "suppressed", helpfulShareBand: null };
  const share = helpful / respondents;
  return {
    disclosure: "coarse-band",
    helpfulShareBand:
      share < 0.25
        ? "0-24%"
        : share < 0.5
          ? "25-49%"
          : share < 0.75
            ? "50-74%"
            : "75-100%",
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
        submittedAssignment: number;
        returnEligible: number;
        crossContentReturned: number;
        usefulnessRespondents: number;
        usefulnessHelpful: number;
        usefulnessNotYet: number;
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
               AND c.left_at IS NULL) AS active_circle,
             EXISTS(SELECT 1 FROM assignment_attempts a
               JOIN assignment_submission_snapshots s ON s.attempt_id=a.id
               WHERE a.member_id=l.id AND s.submitted_at<=CURRENT_TIMESTAMP)
               AS submitted_assignment,
             anchor.opened_at AS first_open,
             anchor.content_id AS first_lesson_id
           FROM learners l LEFT JOIN LATERAL (
             SELECT a.opened_at,a.content_id FROM lesson_activity a
             WHERE a.member_id=l.id AND a.opened_at<=CURRENT_TIMESTAMP
             ORDER BY a.opened_at,a.content_id,a.content_version LIMIT 1
           ) anchor ON TRUE WHERE EXISTS(SELECT 1 FROM authorized)
         ), return_events AS (
           SELECT m.*,
             (m.first_open<=CURRENT_TIMESTAMP-interval '14 days') AS return_eligible,
             (m.first_open<=CURRENT_TIMESTAMP-interval '14 days' AND (
               EXISTS(SELECT 1 FROM lesson_activity a WHERE a.member_id=m.id
                 AND a.content_id<>m.first_lesson_id
                 AND a.opened_at>=m.first_open+interval '7 days'
                 AND a.opened_at<m.first_open+interval '14 days')
               OR EXISTS(SELECT 1 FROM assignment_attempts a
                 JOIN assignment_submission_snapshots s ON s.attempt_id=a.id
                 WHERE a.member_id=m.id
                   AND s.submitted_at>=m.first_open+interval '7 days'
                   AND s.submitted_at<m.first_open+interval '14 days')
             )) AS cross_content_returned
           FROM member_events m
         ), latest_usefulness AS (
           SELECT DISTINCT ON (u.member_id) u.member_id,u.choice
           FROM lesson_usefulness u JOIN learners l ON l.id=u.member_id
           JOIN authorized ON TRUE
           ORDER BY u.member_id,u.updated_at DESC,u.reported_at DESC,
             u.content_id DESC,u.content_version DESC
         ), usefulness_counts AS (
           SELECT COUNT(*)::integer AS respondents,
             COUNT(*) FILTER(WHERE choice='helpful')::integer AS helpful,
             COUNT(*) FILTER(WHERE choice='not_yet')::integer AS not_yet
           FROM latest_usefulness
         )
         SELECT CURRENT_TIMESTAMP AS "asOf",COUNT(*)::integer AS members,
           COUNT(*) FILTER(WHERE activated)::integer AS activated,
           COUNT(*) FILTER(WHERE self_assessed)::integer AS "selfAssessed",
           COUNT(*) FILTER(WHERE participated)::integer AS participated,
           COUNT(*) FILTER(WHERE active_circle)::integer AS "activeCircle",
           COUNT(*) FILTER(WHERE submitted_assignment)::integer AS "submittedAssignment",
           COUNT(*) FILTER(WHERE return_eligible)::integer AS "returnEligible",
           COUNT(*) FILTER(WHERE cross_content_returned)::integer AS "crossContentReturned",
           COALESCE(MAX(uc.respondents),0)::integer AS "usefulnessRespondents",
           COALESCE(MAX(uc.helpful),0)::integer AS "usefulnessHelpful",
           COALESCE(MAX(uc.not_yet),0)::integer AS "usefulnessNotYet"
         FROM return_events CROSS JOIN usefulness_counts uc
         HAVING EXISTS(SELECT 1 FROM authorized)`,
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
          submittedAssignment:
            "Distinct retained members with at least one private assignment submission snapshot, divided by members. This is observed submission, not reviewed project quality or verified skill; revision counts once.",
          returnEligible:
            "Distinct retained members whose first recorded versioned lesson open is at least 14 full days old at asOf. Deleted records are unavailable; this is not an enrollment or acquisition cohort.",
          crossContentReturned:
            "Of returnEligible, distinct members with a different lesson content ID first opened or an assignment submitted at or after 7 full days and before 14 full days from their first lesson open. This is an observed cross-content return proxy, not general learning retention; the same lesson or a newer version alone is not a return. Zero eligible means the rate is undefined.",
          usefulness:
            "Member self-reported usefulness in this synthetic local preview, not observed skill, qualified review or current curriculum quality. Each retained member contributes only their latest corrected exact-version answer; historical versions remain historical. The denominator is respondents, not all members or an enrollment cohort. No exact respondent or choice counts are exposed. The whole block is suppressed below 20 respondents or when either choice has fewer than five; otherwise only a coarse helpful-share band is shown. Repeated snapshots can still permit inference, so this is not approved live analytics.",
        },
        counts: {
          members: row.members,
          activated: row.activated,
          selfAssessed: row.selfAssessed,
          participated: row.participated,
          activeCircle: row.activeCircle,
          submittedAssignment: row.submittedAssignment,
          returnEligible: row.returnEligible,
          crossContentReturned: row.crossContentReturned,
        },
        usefulness: usefulnessDisclosure(
          row.usefulnessRespondents,
          row.usefulnessHelpful,
          row.usefulnessNotYet,
        ),
      };
    },
  };
}
