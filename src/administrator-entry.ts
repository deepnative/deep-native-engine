import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { invoiceUuid } from "./simple-invoice-values.ts";
import { cookieHash } from "./member-sessions.ts";
import { hash } from "./store.ts";
import { ACCOUNT_ROLES, type AccountRole } from "./account-view.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "./practice-session-lifetime.ts";

export type AdministratorResult =
  | { kind: "ready"; credential?: string; expires?: Date }
  // ADMINEXP-01: an earlier entry for this sign-in was never ended.
  | { kind: "denied" | "unavailable" | "unended" };
export const LEARNERS_PER_PAGE = 25;
/** One saved coaching month, as the console summarises it. */
export interface LatestCoaching {
  month: string;
  /** #832: the period's first and last day (a calendar month for YYYY-MM). */
  periodStart?: string;
  periodEnd?: string;
  minutes: number;
  state: string;
  returned: boolean;
  totalCents: string | null;
  paidCents: string | null;
  refundedCents?: string | null;
  voided: boolean;
}
export interface AdministratorConsole {
  members: Array<{
    id: string;
    displayName?: string | null;
    background: string;
    goal: string;
    joined: Date;
    /** CONSOLEMONTHS-03: the latest saved month before last month. */
    coaching?: LatestCoaching | null;
    thisMonth?: LatestCoaching | null;
    lastMonth?: LatestCoaching | null;
  }>;
  /** Calendar months (UTC, from the database clock) for the month columns. */
  months: { current: string; previous: string };
  /** Learners matching the search; `members` holds only the current page. */
  total: number;
  page: number;
  pageSize: number;
  search: string;
  courses: Array<{ id: string; version: number; title: string }>;
  selected?: {
    member: {
      id: string;
      displayName?: string | null;
      background: string;
      goal: string;
      joined: Date;
    };
    enrollments: Array<{ id: string; title: string }>;
    plans: Array<{ id: string; state: string }>;
    invoices: Array<{
      id: string;
      number: string;
      totalCents: string;
      delivery: string;
    }>;
  };
}
export type AdministratorConsoleResult =
  | { kind: "ready"; value: AdministratorConsole }
  | { kind: "denied" | "unavailable" | "not-found" };
export interface AdministratorEntry {
  console?(
    credential: string,
    ownerId?: string,
    view?: { page?: number; search?: string },
  ): Promise<AdministratorConsoleResult>;
  /** Read-only: the account's roles choose its views and grant nothing. */
  accountRoles?(memberToken: string): Promise<AccountRole[]>;
  status(memberToken: string): Promise<AdministratorResult>;
  enter(memberToken: string): Promise<AdministratorResult>;
  end(memberToken: string): Promise<AdministratorResult>;
}
export function administratorEntry(pool: Pool): AdministratorEntry {
  async function run(
    memberToken: string,
    action: "status" | "enter" | "end",
  ): Promise<AdministratorResult> {
    if (!/^[a-f0-9]{64}$/.test(memberToken)) return { kind: "denied" };
    try {
      return await practiceTransaction(pool, async (tx) => {
        const owner = (
          await tx.query<{ id: string; expires: Date; session_expires: Date }>(
            `SELECT p.id,p.expires_at AS expires,
             LEAST(p.expires_at,clock_timestamp()+INTERVAL '8 hours') AS session_expires FROM principals p
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() FOR UPDATE`,
            [hash(memberToken)],
          )
        ).rows[0];
        if (!owner) throw new PracticeLifetimeFailure("denied");
        await tx.observe([owner.expires]);
        const workspace = await tx.query(
          "SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE",
          [owner.id],
        );
        const identity = await tx.query(
          // ROLES-06: entry follows the stored admin role.
          `SELECT 1 FROM member_email_identities i
            JOIN account_roles r ON r.email_hash=i.email_hash AND r.role='admin'
           WHERE i.principal_id=$1 FOR SHARE OF i,r`,
          [owner.id],
        );
        if (!workspace.rowCount || !identity.rowCount)
          throw new PracticeLifetimeFailure("denied");
        if (action === "status") return { kind: "ready" };
        if (action === "end") {
          await tx.query(
            `UPDATE administrator_sessions SET revoked_at=clock_timestamp()
             WHERE member_id=$1 AND member_token_hash=$2 AND revoked_at IS NULL RETURNING staff_id`,
            [owner.id, cookieHash(memberToken)],
          );
          return { kind: "ready" };
        }
        // Expired sessions require deliberate ending, never silent replacement.
        const previous = await tx.query(
          "SELECT 1 FROM administrator_sessions WHERE member_id=$1 AND member_token_hash=$2 AND revoked_at IS NULL",
          [owner.id, cookieHash(memberToken)],
        );
        if (previous.rowCount) return { kind: "unended" as const };
        const expires = owner.session_expires;
        const credential = randomBytes(32).toString("hex"),
          id = randomUUID();
        await tx.query(
          "INSERT INTO principals(id,token_hash,kind,expires_at) VALUES($1,$2,'staff',$3)",
          [id, hash(credential), expires],
        );
        await tx.query(
          "INSERT INTO staff_profiles(principal_id,role) VALUES($1,'platform_admin')",
          [id],
        );
        await tx.query(
          "INSERT INTO administrator_sessions(staff_id,member_id,member_token_hash,expires_at) VALUES($1,$2,$3,$4)",
          // MULTISESSION-05: administration belongs to this browser's session.
          [id, owner.id, cookieHash(memberToken), expires],
        );
        await tx.observe([expires]);
        return { kind: "ready", credential, expires };
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
    async accountRoles(memberToken) {
      if (!/^[a-f0-9]{64}$/.test(memberToken)) return [];
      const held = await pool.query<{ role: string | null }>(
        `SELECT r.role FROM principals p
         JOIN workspaces w ON w.owner_principal_id=p.id AND w.deleting_at IS NULL
         LEFT JOIN member_email_identities i ON i.principal_id=p.id
         LEFT JOIN account_roles r ON r.email_hash=i.email_hash
         WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
           AND p.expires_at>clock_timestamp()`,
        [hash(memberToken)],
      );
      if (!held.rowCount) return [];
      const roles = new Set(held.rows.map((r) => r.role));
      return ACCOUNT_ROLES.filter((r) => r === "student" || roles.has(r));
    },
    async console(credential, ownerId, view = {}) {
      if (
        !/^[a-f0-9]{64}$/.test(credential) ||
        (ownerId !== undefined && !invoiceUuid(ownerId))
      )
        return { kind: "denied" };
      try {
        return await practiceTransaction(pool, async (tx) => {
          const staff = (
            await tx.query<{ expires: Date }>(
              `SELECT p.expires_at AS expires FROM principals p
             JOIN authorized_staff_profiles s ON s.principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='staff' AND p.revoked_at IS NULL
               AND p.expires_at>clock_timestamp() AND s.role='platform_admin'
             FOR SHARE OF p,s`,
              [hash(credential)],
            )
          ).rows[0];
          if (!staff) throw new PracticeLifetimeFailure("denied");
          await tx.observe([staff.expires]);
          const search = (view.search ?? "").trim();
          // The search is literal text, or one exact account reference.
          const filter = [
            search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null,
            invoiceUuid(search) ? search.toLowerCase() : null,
          ];
          const learners = `FROM learners l JOIN principals p ON p.id=l.id
             JOIN workspaces w ON w.owner_principal_id=l.id
             WHERE p.revoked_at IS NULL AND w.deleting_at IS NULL`;
          const matching = `${learners} AND ($1::text IS NULL
               OR l.display_name ILIKE $1 OR l.id=$2::uuid)`;
          // CONSOLEMONTHS-01: months follow the coaching pages' UTC clock.
          const { total, ...months } = (
            await tx.query<{
              total: number;
              current: string;
              previous: string;
            }>(
              `SELECT count(*)::int AS total,
                 to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM') AS current,
                 to_char(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month','YYYY-MM') AS previous
               ${matching}`,
              filter,
            )
          ).rows[0]!;
          const page = Math.min(
            Math.max(view.page ?? 1, 1),
            Math.max(Math.ceil(total / LEARNERS_PER_PAGE), 1),
          );
          const columns = `l.id,l.display_name AS "displayName",l.background,l.goal,p.created_at AS joined`;
          // CONSOLEMONTHS-01..03: this month, last month and the latest
          // earlier month come with the page of learners, in one statement.
          const summary = (where: string) =>
            `(SELECT json_build_object('month',m.month,'periodStart',to_char(m.period_start,'YYYY-MM-DD'),'periodEnd',to_char(m.period_end,'YYYY-MM-DD'),'minutes',m.minutes,'state',m.state,
                'returned',m.return_reason IS NOT NULL,'totalCents',i.total_cents::text,
                'paidCents',i.paid_cents::text,'refundedCents',i.refunded_cents::text,'voided',i.voided_at IS NOT NULL)
              FROM coaching_months m LEFT JOIN simple_invoices i ON i.id=m.invoice_id
              WHERE m.owner_id=l.id AND ${where} ORDER BY m.period_start DESC LIMIT 1)`;
          const members = (
            await tx.query<AdministratorConsole["members"][number]>(
              `SELECT ${columns},
                 ${summary("to_char(m.period_end,'YYYY-MM')=$5")} AS "thisMonth",
                 ${summary("to_char(m.period_end,'YYYY-MM')=$6")} AS "lastMonth",
                 ${summary("to_char(m.period_end,'YYYY-MM')<$6")} AS coaching
               ${matching}
               ORDER BY lower(l.display_name) NULLS LAST,l.display_name,l.id
               LIMIT $3 OFFSET $4`,
              [
                ...filter,
                LEARNERS_PER_PAGE,
                (page - 1) * LEARNERS_PER_PAGE,
                months.current,
                months.previous,
              ],
            )
          ).rows;
          const chosen = ownerId
            ? (
                await tx.query<AdministratorConsole["members"][number]>(
                  `SELECT ${columns} ${learners} AND l.id=$1`,
                  [ownerId],
                )
              ).rows[0]
            : undefined;
          if (ownerId && !chosen) return { kind: "not-found" as const };
          const courses = (
            await tx.query<AdministratorConsole["courses"][number]>(
              `SELECT id,version,title FROM content_versions c WHERE state='published'
             AND kind='lesson' AND NOT requires_qualified_signoff
             AND version=(SELECT max(version) FROM content_versions WHERE id=c.id AND state='published')
             ORDER BY id LIMIT 100`,
            )
          ).rows;
          const value: AdministratorConsole = {
            members,
            months,
            total,
            page,
            pageSize: LEARNERS_PER_PAGE,
            search,
            courses,
          };
          if (ownerId) {
            const enrollments = (
              await tx.query<{ id: string; title: string }>(
                `SELECT e.term_id AS id,t.snapshot->>'title' AS title FROM local_program_enrollments e
               JOIN local_program_terms t ON t.id=e.term_id WHERE e.workspace_id=$1 ORDER BY e.enrolled_at DESC LIMIT 100`,
                [ownerId],
              )
            ).rows;
            const plans = (
              await tx.query<{ id: string; state: string }>(
                "SELECT id,state FROM simple_invoice_plans WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
                [ownerId],
              )
            ).rows;
            const invoices = (
              await tx.query<{
                id: string;
                number: string;
                totalCents: string;
                delivery: string;
              }>(
                `SELECT id,document->>'number' AS number,total_cents::text AS "totalCents",delivery
               FROM simple_invoices WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`,
                [ownerId],
              )
            ).rows;
            value.selected = {
              member: chosen!,
              enrollments,
              plans,
              invoices,
            };
          }
          await tx.observe([staff.expires]);
          return { kind: "ready" as const, value };
        });
      } catch (error) {
        return {
          kind:
            error instanceof PracticeLifetimeFailure && error.kind === "denied"
              ? "denied"
              : "unavailable",
        };
      }
    },
    status: (token) => run(token, "status"),
    enter: (token) => run(token, "enter"),
    end: (token) => run(token, "end"),
  };
}
