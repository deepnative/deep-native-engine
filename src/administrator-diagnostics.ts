import type { Pool, PoolClient } from "pg";
import { emailHash, normalizedEmail } from "./member-email-access.ts";
import { hash } from "./store.ts";

/**
 * DIAG-01/02: fixed, read-only checks an administrator can run on the hosted
 * engine without opening the database to anyone. Every read runs in a
 * read-only transaction after the staff credential is confirmed.
 */
export interface SiteDiagnosis {
  accounts: number;
  verifiedEmails: number;
  unverifiedEmails: number;
  passwords: number;
  /** Email links and no-account notices created in the last 24 hours. */
  day: { attach: number; signIn: number; used: number; notices: number };
  latestMigration: number;
}
export interface EmailDiagnosis {
  /** The address only as the administrator typed it, normalized. */
  address: string;
  verified: {
    accountId: string;
    displayName: string | null;
    since: Date;
  } | null;
  unverified: {
    accountId: string;
    displayName: string | null;
    since: Date;
  } | null;
  links: Array<{
    purpose: "attach" | "sign_in";
    created: Date;
    state: "used" | "open" | "expired";
  }>;
  notices: Date[];
}
export type DiagnosticsResult<T> =
  { kind: "ready"; value: T } | { kind: "denied" | "unavailable" | "invalid" };

export interface AdministratorDiagnostics {
  site(credential: string): Promise<DiagnosticsResult<SiteDiagnosis>>;
  email(
    credential: string,
    address: string,
  ): Promise<DiagnosticsResult<EmailDiagnosis>>;
}

const RECENT = 10;

export function administratorDiagnostics(pool: Pool): AdministratorDiagnostics {
  async function asAdmin<T>(
    credential: string,
    read: (client: PoolClient) => Promise<T>,
  ): Promise<DiagnosticsResult<T>> {
    if (!/^[a-f0-9]{64}$/.test(credential)) return { kind: "denied" };
    const client = await pool.connect().catch(() => undefined);
    if (!client) return { kind: "unavailable" };
    try {
      // The staff view takes share locks to keep its owner checks consistent,
      // so confirm the session first, then read in a read-only transaction.
      await client.query("BEGIN");
      const staff = await client.query(
        `SELECT 1 FROM principals p
         JOIN authorized_staff_profiles s ON s.principal_id=p.id
         WHERE p.token_hash=$1 AND p.kind='staff' AND p.revoked_at IS NULL
           AND p.expires_at>clock_timestamp() AND s.role='platform_admin'`,
        [hash(credential)],
      );
      await client.query("COMMIT");
      if (!staff.rowCount) return { kind: "denied" };
      await client.query("BEGIN READ ONLY");
      return { kind: "ready", value: await read(client) };
    } catch {
      return { kind: "unavailable" };
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
  return {
    site: (credential) =>
      asAdmin(credential, async (client) => {
        const row = (
          await client.query<{
            accounts: number;
            verified: number;
            unverified: number;
            passwords: number;
            attach: number;
            sign_in: number;
            used: number;
            notices: number;
            migration: number;
          }>(
            `SELECT
              (SELECT count(*)::int FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
                WHERE p.kind='member' AND p.revoked_at IS NULL AND w.deleting_at IS NULL) AS accounts,
              (SELECT count(*)::int FROM member_email_identities) AS verified,
              (SELECT count(*)::int FROM member_login_emails) AS unverified,
              (SELECT count(*)::int FROM member_passwords) AS passwords,
              (SELECT count(*)::int FROM member_email_links WHERE purpose='attach'
                AND created_at>clock_timestamp()-INTERVAL '24 hours') AS attach,
              (SELECT count(*)::int FROM member_email_links WHERE purpose='sign_in'
                AND created_at>clock_timestamp()-INTERVAL '24 hours') AS sign_in,
              (SELECT count(*)::int FROM member_email_links WHERE consumed_at IS NOT NULL
                AND created_at>clock_timestamp()-INTERVAL '24 hours') AS used,
              (SELECT count(*)::int FROM member_email_notices
                WHERE created_at>clock_timestamp()-INTERVAL '24 hours') AS notices,
              (SELECT coalesce(max(version),0)::int FROM schema_migrations) AS migration`,
          )
        ).rows[0]!;
        return {
          accounts: row.accounts,
          verifiedEmails: row.verified,
          unverifiedEmails: row.unverified,
          passwords: row.passwords,
          day: {
            attach: row.attach,
            signIn: row.sign_in,
            used: row.used,
            notices: row.notices,
          },
          latestMigration: row.migration,
        };
      }),
    async email(credential, input) {
      const address = normalizedEmail(input);
      if (!address)
        return /^[a-f0-9]{64}$/.test(credential)
          ? { kind: "invalid" }
          : { kind: "denied" };
      const digest = emailHash(address);
      return asAdmin(credential, async (client) => {
        const owner = (table: string) =>
          client
            .query<{
              accountId: string;
              displayName: string | null;
              since: Date;
            }>(
              `SELECT e.principal_id AS "accountId", l.display_name AS "displayName",
                 e.${table === "member_email_identities" ? "verified_at" : "created_at"} AS since
               FROM ${table} e LEFT JOIN learners l ON l.id=e.principal_id
               WHERE e.email_hash=$1`,
              [digest],
            )
            .then((r) => r.rows[0] ?? null);
        const links = await client.query<{
          purpose: "attach" | "sign_in";
          created: Date;
          state: "used" | "open" | "expired";
        }>(
          `SELECT purpose, created_at AS created,
             CASE WHEN consumed_at IS NOT NULL THEN 'used'
                  WHEN expires_at>clock_timestamp() THEN 'open' ELSE 'expired' END AS state
           FROM member_email_links WHERE email_hash=$1
           ORDER BY created_at DESC LIMIT ${RECENT}`,
          [digest],
        );
        const notices = await client.query<{ created: Date }>(
          `SELECT created_at AS created FROM member_email_notices
           WHERE email_hash=$1 ORDER BY created_at DESC LIMIT ${RECENT}`,
          [digest],
        );
        return {
          address,
          verified: await owner("member_email_identities"),
          unverified: await owner("member_login_emails"),
          links: links.rows,
          notices: notices.rows.map((r) => r.created),
        };
      });
    },
  };
}
