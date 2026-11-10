import type { Pool } from "pg";
import { hostingText } from "./hosting-presentation.ts";
import { hash } from "./store.ts";
import {
  contributionMetrics,
  type ContributionMetrics,
} from "./contribution-metrics.ts";
import {
  learningCohorts,
  learningDisclosure,
  learningSegments,
  LEARNING_KEYS,
  type LearningCohort,
  type LearningDisclosure,
  type LearningSegments,
  type RawLearningCell,
} from "./learning-metrics.ts";

export interface PreviewMetrics {
  scope: "synthetic-local-preview";
  /** DEMOACCT-03/04: which accounts every figure counts. */
  accounts: "demo" | "not-demo";
  asOf: Date;
  definitions: {
    accounts: string;
    denominator: string;
    activated: string;
    selfAssessed: string;
    participated: string;
    activeCircle: string;
    submittedAssignment: string;
    returnEligible: string;
    crossContentReturned: string;
    reportedOutcome: string;
    enrolledInProgram: string;
    withdrewFromProgram: string;
    usefulness: string;
    segments: string;
    cohorts: string;
    cohortActivated: string;
    cohortSelfAssessed: string;
    cohortSubmittedAssignment: string;
    cohortContinued: string;
  };
  learning: LearningDisclosure;
  segments: LearningSegments;
  cohorts: LearningCohort[];
  usefulness: UsefulnessDisclosure;
  contributions: ContributionMetrics;
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
  /** #40 EXPORTLOG: false when this token may not take the JSON. */
  logExport(token: string): Promise<boolean>;
}

export function disabledMetricsStore(): MetricsStore {
  return { snapshot: async () => null, logExport: async () => false };
}

// One distinct-revision and distinct-owner cell for the events matching a filter.
const cell = (filter: string) =>
  `jsonb_build_object('revisions',COUNT(DISTINCT e.proposal_id::text||':'||e.revision) FILTER(WHERE ${filter}),'owners',COUNT(DISTINCT e.member_id) FILTER(WHERE ${filter}))`;
const contributionVolumes = {
  submitted: "e.kind='submitted'",
  reviewed: "e.kind='reviewed'",
  accepted: "e.kind='accepted'",
  published: "e.kind='published'",
  sourceWithdrawn: "e.kind='source_withdrawn'",
  sharingWithdrawnByOwner: "e.kind='sharing_withdrawn' AND e.cause='owner'",
  sharingWithdrawnBySourceChange:
    "e.kind='sharing_withdrawn' AND e.cause='source_change'",
};
// A first decision counts toward the share only when its submission was also
// recorded after the cutoff, so incomplete chains stay out of the rate.
const firstDecision = `e.kind='reviewed' AND EXISTS(SELECT 1 FROM contribution_retained s
  WHERE s.kind='submitted' AND s.proposal_id=e.proposal_id AND s.revision=e.revision)`;

// One group's exact counts. They stay in this module; see learning-metrics.ts.
const learningCell = `jsonb_build_object('members',COUNT(*),${LEARNING_KEYS.map(
  (key) => `'${key}',COUNT(*) FILTER(WHERE ${snake(key)})`,
).join(",")})`;
function snake(key: string) {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
const COHORT_MONTHS = 12;

/**
 * The exact aggregate, for this module and its database tests only. No route
 * may serve it: `snapshot` is the disclosed form.
 */
export async function exactMetrics(
  pool: Pool,
  token: string,
  demoSite = false,
) {
  const result = await pool.query<
    RawLearningCell & {
      asOf: Date;
      segments: unknown;
      cohorts: unknown;
      usefulnessRespondents: number;
      usefulnessHelpful: number;
      usefulnessNotYet: number;
      contributionsSince: Date | null;
      contributions: unknown;
    }
  >(
    `WITH authorized AS (
           SELECT 1 FROM principals p JOIN authorized_staff_profiles s ON s.principal_id=p.id
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
             EXISTS(SELECT 1 FROM lesson_activity a WHERE a.member_id=l.id
               AND a.opened_at>=j.joined AND a.opened_at<j.joined+interval '14 days')
               AS cohort_activated,
             EXISTS(SELECT 1 FROM lesson_activity a WHERE a.member_id=l.id
               AND a.self_assessed_at>=j.joined
               AND a.self_assessed_at<j.joined+interval '14 days')
               AS cohort_self_assessed,
             EXISTS(SELECT 1 FROM assignment_attempts a
               JOIN assignment_submission_snapshots s ON s.attempt_id=a.id
               WHERE a.member_id=l.id AND s.submitted_at>=j.joined
                 AND s.submitted_at<j.joined+interval '30 days')
               AS cohort_submitted_assignment,
             (EXISTS(SELECT 1 FROM lesson_activity a WHERE a.member_id=l.id
                AND a.opened_at>=j.joined+interval '7 days'
                AND a.opened_at<j.joined+interval '30 days')
              OR EXISTS(SELECT 1 FROM assignment_attempts a
                JOIN assignment_submission_snapshots s ON s.attempt_id=a.id
                WHERE a.member_id=l.id
                  AND s.submitted_at>=j.joined+interval '7 days'
                  AND s.submitted_at<j.joined+interval '30 days'))
               AS cohort_continued,
             -- #123 OUTCOME: the member's own words on their own plan entries.
             EXISTS(SELECT 1 FROM career_entries c WHERE c.member_id=l.id
               AND btrim(c.self_reported_outcome)<>'') AS reported_outcome,
             EXISTS(SELECT 1 FROM local_program_enrollments e WHERE e.workspace_id=l.id)
               AS enrolled_in_program,
             EXISTS(SELECT 1 FROM local_program_withdrawals w WHERE w.workspace_id=l.id)
               AS withdrew_from_program,
             l.background,l.goal,l.background_tags,j.joined,
             anchor.opened_at AS first_open,
             anchor.content_id AS first_lesson_id
           FROM learners l JOIN LATERAL (
             SELECT p.created_at AS joined FROM principals p WHERE p.id=l.id
           ) j ON TRUE LEFT JOIN LATERAL (
             SELECT a.opened_at,a.content_id FROM lesson_activity a
             WHERE a.member_id=l.id AND a.opened_at<=CURRENT_TIMESTAMP
             ORDER BY a.opened_at,a.content_id,a.content_version LIMIT 1
           ) anchor ON TRUE WHERE EXISTS(SELECT 1 FROM authorized)
             AND l.created_on_demo_site=$2
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
         ), background_cells AS (
           SELECT background AS key,${learningCell} AS cell
           FROM return_events GROUP BY background
         ), goal_cells AS (
           SELECT goal AS key,${learningCell} AS cell
           FROM return_events GROUP BY goal
         ), interest_cells AS (
           SELECT t.key,${learningCell} AS cell
           FROM return_events r CROSS JOIN LATERAL unnest(r.background_tags) t(key)
           GROUP BY t.key
         ), cohort_cells AS (
           SELECT to_char(joined AT TIME ZONE 'UTC','YYYY-MM') AS month,
             (date_trunc('month',joined AT TIME ZONE 'UTC')+interval '1 month'+interval '30 days')
               <=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS closed,
             COUNT(*)::integer AS members,
             COUNT(*) FILTER(WHERE cohort_activated)::integer AS activated,
             COUNT(*) FILTER(WHERE cohort_self_assessed)::integer AS "selfAssessed",
             COUNT(*) FILTER(WHERE cohort_submitted_assignment)::integer AS "submittedAssignment",
             COUNT(*) FILTER(WHERE cohort_continued)::integer AS continued
           FROM return_events GROUP BY 1,2 ORDER BY 1 DESC LIMIT ${COHORT_MONTHS}
         ), latest_usefulness AS (
           SELECT DISTINCT ON (u.member_id) u.member_id,u.choice
           FROM lesson_usefulness u JOIN learners l ON l.id=u.member_id
             AND l.created_on_demo_site=$2
           JOIN authorized ON TRUE
           ORDER BY u.member_id,u.updated_at DESC,u.reported_at DESC,
             u.content_id DESC,u.content_version DESC
         ), usefulness_counts AS (
           SELECT COUNT(*)::integer AS respondents,
             COUNT(*) FILTER(WHERE choice='helpful')::integer AS helpful,
             COUNT(*) FILTER(WHERE choice='not_yet')::integer AS not_yet
           FROM latest_usefulness
         ), contribution_retained AS (
           SELECT e.* FROM contribution_events e JOIN learners l ON l.id=e.member_id
           WHERE EXISTS(SELECT 1 FROM authorized) AND l.created_on_demo_site=$2
         ), contribution_groups AS (
           SELECT o.origin,jsonb_build_object(
             'contributors',COUNT(DISTINCT e.member_id) FILTER(WHERE e.kind='submitted'),
             'volumes',jsonb_build_object(${Object.entries(contributionVolumes)
               .map(([key, filter]) => `'${key}',${cell(filter)}`)
               .join(",")}),
             'firstAccepted',${cell(`${firstDecision} AND e.outcome='accepted'`)},
             'firstNotAccepted',${cell(`${firstDecision} AND e.outcome<>'accepted'`)}
           ) AS summary
           FROM (VALUES ('member'),('sample')) o(origin)
           LEFT JOIN contribution_retained e ON e.origin=o.origin
           GROUP BY o.origin
         )
         SELECT CURRENT_TIMESTAMP AS "asOf",COUNT(*)::integer AS members,
           COUNT(*) FILTER(WHERE activated)::integer AS activated,
           COUNT(*) FILTER(WHERE self_assessed)::integer AS "selfAssessed",
           COUNT(*) FILTER(WHERE participated)::integer AS participated,
           COUNT(*) FILTER(WHERE active_circle)::integer AS "activeCircle",
           COUNT(*) FILTER(WHERE submitted_assignment)::integer AS "submittedAssignment",
           COUNT(*) FILTER(WHERE return_eligible)::integer AS "returnEligible",
           COUNT(*) FILTER(WHERE cross_content_returned)::integer AS "crossContentReturned",
           COUNT(*) FILTER(WHERE reported_outcome)::integer AS "reportedOutcome",
           COUNT(*) FILTER(WHERE enrolled_in_program)::integer AS "enrolledInProgram",
           COUNT(*) FILTER(WHERE withdrew_from_program)::integer AS "withdrewFromProgram",
           COALESCE(MAX(uc.respondents),0)::integer AS "usefulnessRespondents",
           COALESCE(MAX(uc.helpful),0)::integer AS "usefulnessHelpful",
           COALESCE(MAX(uc.not_yet),0)::integer AS "usefulnessNotYet",
           jsonb_build_object(
             'background',(SELECT jsonb_object_agg(key,cell) FROM background_cells),
             'goal',(SELECT jsonb_object_agg(key,cell) FROM goal_cells),
             'interests',(SELECT jsonb_object_agg(key,cell) FROM interest_cells)
           ) AS segments,
           (SELECT jsonb_agg(c ORDER BY c.month DESC) FROM cohort_cells c) AS cohorts,
           (SELECT started_at FROM contribution_metrics_cutoff) AS "contributionsSince",
           (SELECT jsonb_object_agg(origin,summary) FROM contribution_groups) AS contributions
         FROM return_events CROSS JOIN usefulness_counts uc
         HAVING EXISTS(SELECT 1 FROM authorized)`,
    [hash(token), demoSite],
  );
  return result.rows[0] ?? null;
}

/** #730 The report shows this text, so hosted pages get plain wording here. */
export function metricDefinitions(
  demoSite = false,
): PreviewMetrics["definitions"] {
  return {
    accounts: demoSite
      ? "This site runs as a demo, so every figure counts only accounts created on the demo. They are test data, not live figures."
      : "Every figure counts only accounts that were not created while the site ran as a demo. Demo accounts and their activity are left out.",
    denominator: `Current retained ${hostingText("local-preview ", "")}member records at asOf; deleted members cannot be reconstructed. Expired and revoked sessions remain included.`,
    activated:
      "Distinct members with at least one versioned lesson open, divided by members. Opening does not establish learning.",
    selfAssessed:
      "Distinct members with at least one self-assessed lesson completion, divided by members. This is not observed skill or formal assessment.",
    participated: `Distinct members who ever joined a ${hostingText("local ", "")}circle, divided by members. Leaving does not remove them from this numerator.`,
    activeCircle: `Distinct members with a ${hostingText("local ", "")}circle membership whose left_at is empty, divided by members. No shared community or clinic is implied.`,
    submittedAssignment:
      "Distinct retained members with at least one private assignment submission snapshot, divided by members. This is observed submission, not reviewed project quality or verified skill; revision counts once.",
    returnEligible:
      "Distinct retained members whose first recorded versioned lesson open is at least 14 full days old at asOf. Deleted records are unavailable; this is not an enrollment or acquisition cohort.",
    crossContentReturned:
      "Of returnEligible, distinct members with a different lesson content ID first opened or an assignment submitted at or after 7 full days and before 14 full days from their first lesson open. This is an observed cross-content return proxy, not general learning retention; the same lesson or a newer version alone is not a return. Zero eligible means the rate is undefined.",
    reportedOutcome:
      "Member-reported: distinct retained members who wrote a self-reported outcome on at least one of their own private career, opportunity or contract plan entries, divided by members. It is not verified, and it is not a hiring, placement, contract or income rate. Plans without an outcome don't count. Outcome text is never read into this report.",
    enrolledInProgram:
      "Distinct retained members with a dated enrollment in the foundation program term, divided by members. Enrolling is a simulation with no charge, teaching service or qualification.",
    withdrewFromProgram:
      "Of all members, distinct retained members who deliberately withdrew from their program term, each with its own date. Withdrawal is separate from deleting an account: deleted accounts are not counted anywhere, and a withdrawal keeps the enrollment and earlier activity.",
    usefulness: `Member self-reported usefulness ${hostingText("in this synthetic local preview", "on this site")}, not observed skill, qualified review or current curriculum quality. Each retained member contributes only their latest corrected exact-version answer; historical versions remain historical. The denominator is respondents, not all members or an enrollment cohort. No exact respondent or choice counts are exposed. The whole block is suppressed below 20 respondents or when either choice has fewer than five; otherwise only a coarse helpful-share band is shown. Repeated snapshots can still permit inference, so this is not approved live analytics.`,
    segments:
      "The same measures for each current starting point, current goal and interest tag. Interest tags overlap, so segment rows can add up to more than the total. A segment is suppressed below 20 members or when fewer than five members lie outside it; every segment is always listed, so a suppressed row may be zero or not. A segment is a member's own current choice; it never implies a paid tier, career path or staff right.",
    cohorts:
      "Retained members grouped by the UTC calendar month they joined, latest 12 months, each measured over fixed windows from their own join time. Later events do not count. A cohort shows no values until 30 days after its month ends. Deleting an account removes it from its cohort, so denominators shrink and earlier months can change; historical deleted accounts cannot be reconstructed.",
    cohortActivated:
      "Observed: opened a versioned lesson within 14 days of joining.",
    cohortSelfAssessed:
      "Self-reported: completed a lesson self-assessment within 14 days of joining. This is not observed skill.",
    cohortSubmittedAssignment:
      "Observed: submitted an assignment within 30 days of joining. This is not reviewed project quality.",
    cohortContinued:
      "Observed: opened a lesson or submitted an assignment from day 7 up to day 30 after joining.",
  };
}

/** DEMOACCT-03/04: a demo site counts its demo accounts; any other site leaves them out. */
export function metricsStore(
  pool: Pool,
  settings: { demoSite?: boolean } = {},
): MetricsStore {
  const demoSite = settings.demoSite === true;
  return {
    async logExport(token) {
      const logged = await pool.query(
        `INSERT INTO staff_export_events(actor_id,action)
         SELECT p.id,'metrics_json' FROM principals p
         JOIN authorized_staff_profiles s ON s.principal_id=p.id
         WHERE p.token_hash=$1 AND p.kind='staff'
           AND s.role IN ('operator','platform_admin')
           AND p.revoked_at IS NULL AND p.expires_at>CURRENT_TIMESTAMP`,
        [hash(token)],
      );
      return logged.rowCount === 1;
    },
    async snapshot(token) {
      const row = await exactMetrics(pool, token, demoSite);
      if (!row) return null;
      return {
        scope: "synthetic-local-preview",
        accounts: demoSite ? "demo" : "not-demo",
        asOf: row.asOf,
        definitions: metricDefinitions(demoSite),
        learning: learningDisclosure(row),
        segments: learningSegments(row.segments, row.members),
        cohorts: learningCohorts(row.cohorts),
        usefulness: usefulnessDisclosure(
          row.usefulnessRespondents,
          row.usefulnessHelpful,
          row.usefulnessNotYet,
        ),
        contributions: contributionMetrics(
          row.contributionsSince,
          row.contributions,
        ),
      };
    },
  };
}
