import type { Pool } from "pg";
import { coachingMonth } from "./coaching-values.ts";
import { hash } from "./store.ts";

/** One person's saved month as a coach sees it: hours only, no billing. */
export type CoachRow = {
  name: string | null;
  minutes: number;
  status: string;
  /** #832: the dates of an administrator-defined period; absent for a month. */
  period?: { key: string; start: string; end: string };
};
export type CoachSummaryResult =
  | {
      kind: "ready";
      /** `assigned` counts every learner assigned to this coach (#696). */
      value: {
        month: string;
        today: string;
        assigned: number;
        rows: CoachRow[];
      };
    }
  | { kind: "denied" | "invalid" | "unavailable" };
export interface CoachView {
  summary(memberToken: string, month?: string): Promise<CoachSummaryResult>;
}

function status(state: string, returned: boolean) {
  if (state === "submitted") return "Submitted";
  if (state === "invoiced") return "Reviewed";
  return returned ? "Returned for changes" : "Draft";
}

/** #673 ROLES-03/04: read-only Coaching summary for accounts with the coach role,
 * limited to the learners an administrator assigned to them (#684). */
export function coachViewStore(pool: Pool): CoachView {
  return {
    async summary(memberToken, month) {
      if (!/^[a-f0-9]{64}$/.test(memberToken)) return { kind: "denied" };
      if (month !== undefined && !coachingMonth(month))
        return { kind: "invalid" };
      try {
        const coach = await pool.query<{ today: string; assigned: number }>(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS today,
                  (SELECT count(DISTINCT a.learner_id)::integer FROM coach_assignments a
                     JOIN member_email_identities e ON e.email_hash=a.coach_email_hash
                    WHERE e.principal_id=p.id) AS assigned
             FROM principals p
             JOIN workspaces w ON w.owner_principal_id=p.id AND w.deleting_at IS NULL
             JOIN member_email_identities i ON i.principal_id=p.id
             JOIN account_roles r ON r.email_hash=i.email_hash AND r.role='coach'
            WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
              AND p.expires_at>clock_timestamp() LIMIT 1`,
          [hash(memberToken)],
        );
        const today = coach.rows[0]?.today;
        if (!today) return { kind: "denied" };
        const selected = month ?? today;
        if (selected > today) return { kind: "invalid" };
        const rows = await pool.query<{
          displayName: string | null;
          minutes: number;
          state: string;
          returned: boolean;
          key: string;
          start: string;
          end: string;
        }>(
          `SELECT l.display_name AS "displayName",m.minutes,m.state,
                  m.return_reason IS NOT NULL AS returned,m.month AS key,
                  to_char(m.period_start,'YYYY-MM-DD') AS start,to_char(m.period_end,'YYYY-MM-DD') AS "end"
             FROM coaching_months m
             JOIN learners l ON l.id=m.owner_id
             JOIN workspaces w ON w.owner_principal_id=l.id AND w.deleting_at IS NULL
            -- #832: a billing period counts in the month it ends in.
            WHERE to_char(m.period_end,'YYYY-MM')=$1 AND m.owner_id IN (
              -- #684 COACHLINK-02: only learners assigned to this coach.
              SELECT a.learner_id FROM coach_assignments a
                JOIN member_email_identities i ON i.email_hash=a.coach_email_hash
                JOIN principals c ON c.id=i.principal_id
               WHERE c.token_hash=$2)
            ORDER BY l.display_name NULLS LAST,l.id,m.period_start LIMIT 200`,
          [selected, hash(memberToken)],
        );
        return {
          kind: "ready",
          value: {
            month: selected,
            today,
            assigned: coach.rows[0]!.assigned,
            rows: rows.rows.map((r) => ({
              name: r.displayName,
              minutes: r.minutes,
              status: status(r.state, r.returned),
              ...(r.key.length === 10
                ? { period: { key: r.key, start: r.start, end: r.end } }
                : {}),
            })),
          },
        };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
