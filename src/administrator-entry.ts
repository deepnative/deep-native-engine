import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { invoiceUuid } from "./simple-invoice-values.ts";
import { hash } from "./store.ts";
import {
  practiceTransaction,
  PracticeLifetimeFailure,
} from "./practice-session-lifetime.ts";

const selected = ["shi@deepnative.io", "tom@deepnative.io"].map((address) =>
  createHash("sha256").update(address).digest("hex"),
);
export type AdministratorResult =
  | { kind: "ready"; credential?: string; expires?: Date }
  | { kind: "denied" | "unavailable" };
export interface AdministratorConsole {
  members: Array<{
    id: string;
    displayName?: string | null;
    background: string;
    goal: string;
  }>;
  courses: Array<{ id: string; version: number; title: string }>;
  selected?: {
    member: {
      id: string;
      displayName?: string | null;
      background: string;
      goal: string;
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
  ): Promise<AdministratorConsoleResult>;
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
          "SELECT 1 FROM member_email_identities WHERE principal_id=$1 AND email_hash=ANY($2::text[]) FOR SHARE",
          [owner.id, selected],
        );
        if (!workspace.rowCount || !identity.rowCount)
          throw new PracticeLifetimeFailure("denied");
        if (action === "status") return { kind: "ready" };
        if (action === "end") {
          await tx.query(
            `UPDATE administrator_sessions SET revoked_at=clock_timestamp()
             WHERE member_id=$1 AND member_token_hash=$2 AND revoked_at IS NULL RETURNING staff_id`,
            [owner.id, hash(memberToken)],
          );
          return { kind: "ready" };
        }
        // Expired sessions require deliberate ending, never silent replacement.
        const previous = await tx.query(
          "SELECT 1 FROM administrator_sessions WHERE member_id=$1 AND member_token_hash=$2 AND revoked_at IS NULL",
          [owner.id, hash(memberToken)],
        );
        if (previous.rowCount) throw new PracticeLifetimeFailure("denied");
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
          [id, owner.id, hash(memberToken), expires],
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
    async console(credential, ownerId) {
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
          const members = (
            await tx.query<AdministratorConsole["members"][number]>(
              `SELECT l.id,l.display_name AS "displayName",l.background,l.goal FROM learners l
             JOIN principals p ON p.id=l.id JOIN workspaces w ON w.owner_principal_id=l.id
             WHERE p.revoked_at IS NULL AND w.deleting_at IS NULL
               AND ($1::uuid IS NULL OR l.id=$1) ORDER BY l.id LIMIT 100`,
              [ownerId ?? null],
            )
          ).rows;
          if (ownerId && !members.length) return { kind: "not-found" as const };
          const courses = (
            await tx.query<AdministratorConsole["courses"][number]>(
              `SELECT id,version,title FROM content_versions c WHERE state='published'
             AND kind='lesson' AND NOT requires_qualified_signoff
             AND version=(SELECT max(version) FROM content_versions WHERE id=c.id AND state='published')
             ORDER BY id LIMIT 100`,
            )
          ).rows;
          const value: AdministratorConsole = { members, courses };
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
              member: members[0]!,
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
