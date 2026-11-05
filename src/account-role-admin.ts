import type { Pool, PoolClient } from "pg";
import {
  emailHash,
  normalizedEmail,
  transaction,
} from "./member-email-access.ts";
import { invoiceUuid } from "./simple-invoice-values.ts";
import { hash } from "./store.ts";

/** The roles an administrator can grant; every account is already a student. */
export type GrantedRole = "coach" | "admin";
export const GRANTED_ROLES: readonly GrantedRole[] = ["coach", "admin"];
export const grantedRole = (value: unknown): value is GrantedRole =>
  value === "coach" || value === "admin";
export const emailHashValue = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export type RoleHolder = {
  emailHash: string;
  roles: GrantedRole[];
  /** Accounts verified with this email; empty until the person signs up. */
  people: { id: string; name: string | null }[];
  /** A masked address such as `co…@example.test`, saved at grant time (#696). */
  hint: string | null;
  /** The UTC date (YYYY-MM-DD) the earliest role was granted, when known. */
  grantedAt: string | null;
  /** True when the email belongs to the acting administrator. */
  self: boolean;
};

/** #696 ROLE-LABEL-01: the first letters and the domain, never the full address. */
export function maskedEmail(email: string) {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  return `${local.slice(0, local.length > 2 ? 2 : 1)}…${email.slice(at)}`;
}
export type CoachChoice = { emailHash: string; label: string };
type Refusal<K extends string> = { kind: K };
type Failure = Refusal<"denied" | "unavailable">;
export type RolesResult =
  { kind: "ready"; value: { holders: RoleHolder[] } } | Failure;
export type ChangeResult =
  { kind: "ready" } | Failure | Refusal<"invalid" | "not-found" | "self">;
export type LearnerCoachResult =
  | {
      kind: "ready";
      /** `assigned` holds the email hashes of the learner's current coaches. */
      value: { assigned: string[]; coaches: CoachChoice[] };
    }
  | Failure
  | Refusal<"not-found">;

export interface AccountRoleAdmin {
  roles(staffToken: string): Promise<RolesResult>;
  grant(
    staffToken: string,
    input: { email: string; roles: GrantedRole[] },
  ): Promise<ChangeResult>;
  remove(
    staffToken: string,
    input: { emailHash: string; role: GrantedRole },
  ): Promise<ChangeResult>;
  learnerCoaches(
    staffToken: string,
    learnerId: string,
  ): Promise<LearnerCoachResult>;
  /** Replaces the learner's coaches with exactly `coaches`. */
  setCoaches(
    staffToken: string,
    input: { learnerId: string; coaches: string[] },
  ): Promise<ChangeResult>;
}

class Refused extends Error {
  readonly kind: "denied" | "invalid" | "not-found" | "self";
  constructor(kind: Refused["kind"]) {
    super(kind);
    this.kind = kind;
  }
}
const label = (names: (string | null)[], hint: string | null) =>
  names.length
    ? names.map((name) => name ?? "Name needed").join(", ")
    : hint
      ? `${hint} (not signed up yet)`
      : "Email not linked to an account yet";

/**
 * #684 ROLEADMIN / COACHLINK: administrators manage coach and admin roles
 * and set each learner's coaches (#689: several per learner). Every call re-checks the current
 * administrator session through the shared `authorized_staff_profiles` fence.
 */
export function accountRoleAdmin(pool: Pool): AccountRoleAdmin {
  // K names the refusals `use` may throw, so each method keeps its own result type.
  async function run<T, K extends Refused["kind"] = never>(
    staffToken: string,
    use: (tx: PoolClient, actor: { id: string; own: string[] }) => Promise<T>,
  ): Promise<T | Failure | Refusal<K>> {
    if (!/^[a-f0-9]{64}$/.test(staffToken)) return { kind: "denied" };
    try {
      return await transaction(pool, async (tx) => {
        const actor = (
          await tx.query<{ id: string; own: string[] }>(
            `SELECT p.id,COALESCE(array_agg(e.email_hash) FILTER (WHERE e.email_hash IS NOT NULL),'{}') AS own
               FROM principals p
               JOIN authorized_staff_profiles s ON s.principal_id=p.id
               JOIN administrator_sessions a ON a.staff_id=p.id
               LEFT JOIN member_email_identities e ON e.principal_id=a.member_id
              WHERE p.token_hash=$1 AND p.kind='staff' AND p.revoked_at IS NULL
                AND p.expires_at>clock_timestamp() AND s.role='platform_admin'
              GROUP BY p.id`,
            [hash(staffToken)],
          )
        ).rows[0];
        if (!actor) throw new Refused("denied");
        return use(tx, actor);
      });
    } catch (error) {
      return error instanceof Refused
        ? ({ kind: error.kind } as Refusal<K> | Failure)
        : { kind: "unavailable" };
    }
  }
  const record = (
    tx: PoolClient,
    actor: string,
    action: string,
    fields: { emailHash: string; role?: string; learnerId?: string },
  ) =>
    tx.query(
      "INSERT INTO account_role_events(actor_id,action,email_hash,role,learner_id) VALUES($1,$2,$3,$4,$5)",
      [
        actor,
        action,
        fields.emailHash,
        fields.role ?? null,
        fields.learnerId ?? null,
      ],
    );
  // Names of the live accounts verified with each email hash.
  const holders = `SELECT r.email_hash AS "emailHash",
        array_agg(DISTINCT r.role) AS roles,
        max(r.email_hint) AS hint,
        to_char(min(r.granted_at) AT TIME ZONE 'UTC','YYYY-MM-DD') AS "grantedAt",
        COALESCE(json_agg(DISTINCT jsonb_build_object('id',l.id,'name',l.display_name))
          FILTER (WHERE l.id IS NOT NULL),'[]') AS people
     FROM account_roles r
     LEFT JOIN member_email_identities e ON e.email_hash=r.email_hash
     LEFT JOIN principals p ON p.id=e.principal_id AND p.revoked_at IS NULL
     LEFT JOIN workspaces w ON w.owner_principal_id=p.id AND w.deleting_at IS NULL
     LEFT JOIN learners l ON l.id=p.id AND w.id IS NOT NULL`;

  return {
    roles: (staffToken) =>
      run<Extract<RolesResult, { kind: "ready" }>>(
        staffToken,
        async (tx, actor) => {
          const rows = await tx.query<{
            emailHash: string;
            roles: GrantedRole[];
            people: { id: string; name: string | null }[];
            hint: string | null;
            grantedAt: string | null;
          }>(
            `${holders} GROUP BY r.email_hash
           ORDER BY min(l.display_name) NULLS LAST, r.email_hash LIMIT 500`,
          );
          return {
            kind: "ready" as const,
            value: {
              holders: rows.rows.map((h) => ({
                emailHash: h.emailHash,
                roles: GRANTED_ROLES.filter((r) => h.roles.includes(r)),
                people: h.people,
                hint: h.hint,
                grantedAt: h.grantedAt,
                self: actor.own.includes(h.emailHash),
              })),
            },
          };
        },
      ),

    async grant(staffToken, input) {
      const email = normalizedEmail(input.email);
      if (
        !email ||
        !input.roles.length ||
        !input.roles.every(grantedRole) ||
        new Set(input.roles).size !== input.roles.length
      )
        return { kind: "invalid" };
      const target = emailHash(email),
        hint = maskedEmail(email);
      return run<{ kind: "ready" }, "invalid" | "not-found" | "self">(
        staffToken,
        async (tx, actor) => {
          for (const role of GRANTED_ROLES.filter((r) =>
            input.roles.includes(r),
          ))
            if (
              (
                await tx.query(
                  "INSERT INTO account_roles(email_hash,role,email_hint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                  [target, role, hint],
                )
              ).rowCount
            )
              await record(tx, actor.id, "granted", {
                emailHash: target,
                role,
              });
          // ROLE-LABEL-01: roles granted before hints existed gain one.
          await tx.query(
            "UPDATE account_roles SET email_hint=$2 WHERE email_hash=$1 AND email_hint IS NULL",
            [target, hint],
          );
          return { kind: "ready" as const };
        },
      );
    },

    async remove(staffToken, input) {
      if (!emailHashValue(input.emailHash) || !grantedRole(input.role))
        return { kind: "invalid" };
      return run<{ kind: "ready" }, "invalid" | "not-found" | "self">(
        staffToken,
        async (tx, actor) => {
          // ROLEADMIN-04: the acting administrator keeps their own admin role,
          // so at least one administrator always remains.
          if (input.role === "admin" && actor.own.includes(input.emailHash))
            throw new Refused("self");
          const removed = await tx.query(
            "DELETE FROM account_roles WHERE email_hash=$1 AND role=$2",
            [input.emailHash, input.role],
          );
          if (!removed.rowCount) throw new Refused("not-found");
          await record(tx, actor.id, "removed", input);
          return { kind: "ready" as const };
        },
      );
    },

    async learnerCoaches(staffToken, learnerId) {
      if (!invoiceUuid(learnerId)) return { kind: "not-found" };
      return run<Extract<LearnerCoachResult, { kind: "ready" }>, "not-found">(
        staffToken,
        async (tx) => {
          const learner = await tx.query<{ assigned: string[] }>(
            `SELECT COALESCE(array_agg(a.coach_email_hash ORDER BY a.coach_email_hash)
                      FILTER (WHERE a.coach_email_hash IS NOT NULL),'{}') AS assigned
               FROM learners l
               LEFT JOIN coach_assignments a ON a.learner_id=l.id
              WHERE l.id=$1 GROUP BY l.id`,
            [learnerId],
          );
          if (!learner.rowCount) throw new Refused("not-found");
          const coaches = await tx.query<{
            emailHash: string;
            people: { name: string | null }[];
            hint?: string | null;
          }>(`${holders} WHERE r.role='coach' GROUP BY r.email_hash`);
          return {
            kind: "ready" as const,
            value: {
              assigned: learner.rows[0]!.assigned,
              coaches: coaches.rows
                .map((c) => ({
                  emailHash: c.emailHash,
                  label: label(
                    c.people.map((p) => p.name),
                    c.hint ?? null,
                  ),
                }))
                .sort(
                  (a, b) =>
                    a.label.localeCompare(b.label) ||
                    a.emailHash.localeCompare(b.emailHash),
                ),
            },
          };
        },
      );
    },

    async setCoaches(staffToken, input) {
      if (!invoiceUuid(input.learnerId)) return { kind: "not-found" };
      const coaches = input.coaches;
      if (
        coaches.length > 100 ||
        !coaches.every(emailHashValue) ||
        new Set(coaches).size !== coaches.length
      )
        return { kind: "invalid" };
      return run<{ kind: "ready" }, "invalid" | "not-found" | "self">(
        staffToken,
        async (tx, actor) => {
          const learner = await tx.query(
            "SELECT 1 FROM learners WHERE id=$1 FOR UPDATE",
            [input.learnerId],
          );
          if (!learner.rowCount) throw new Refused("not-found");
          const held = await tx.query(
            "SELECT 1 FROM account_roles WHERE email_hash=ANY($1) AND role='coach' FOR SHARE",
            [coaches],
          );
          if (held.rowCount !== coaches.length) throw new Refused("invalid");
          const removed = await tx.query<{ coach: string }>(
            `DELETE FROM coach_assignments
              WHERE learner_id=$1 AND NOT coach_email_hash=ANY($2)
             RETURNING coach_email_hash AS coach`,
            [input.learnerId, coaches],
          );
          const added = await tx.query<{ coach: string }>(
            `INSERT INTO coach_assignments(learner_id,coach_email_hash,assigned_by)
             SELECT $1,c,$3 FROM unnest($2::text[]) c
             ON CONFLICT DO NOTHING RETURNING coach_email_hash AS coach`,
            [input.learnerId, coaches, actor.id],
          );
          for (const [action, rows] of [
            ["cleared", removed.rows],
            ["assigned", added.rows],
          ] as const)
            for (const row of [...rows].sort((a, b) =>
              a.coach.localeCompare(b.coach),
            ))
              await record(tx, actor.id, action, {
                emailHash: row.coach,
                learnerId: input.learnerId,
              });
          return { kind: "ready" as const };
        },
      );
    },
  };
}
