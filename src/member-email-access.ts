import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

export type EmailPurpose = "attach" | "sign_in";
export interface MemberEmailSender {
  send(address: string, link: string): Promise<void>;
}
export interface MemberEmailAccess {
  requestAttach(
    memberToken: string,
    address: string,
  ): Promise<"sent" | "unavailable">;
  requestSignIn(address: string): Promise<void>;
  consume(
    code: string,
    currentToken?: string,
  ): Promise<{
    kind: "attached" | "signed_in" | "unavailable";
    token?: string;
  }>;
}

export function normalizedEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}

function emailHash(address: string) {
  return createHash("sha256").update(address).digest("hex");
}

async function transaction<T>(
  pool: Pool,
  use: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  let discarded = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    const result = await use(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      client.release(new Error("Email access rollback failed"));
      discarded = true;
      throw error;
    }
    throw error;
  } finally {
    if (!discarded) client.release();
  }
}

export function memberEmailAccess(
  pool: Pool,
  sender: MemberEmailSender,
  origin: string,
): MemberEmailAccess {
  async function request(
    purpose: EmailPurpose,
    address: string,
    memberToken?: string,
  ): Promise<"sent" | "unavailable"> {
    const normalized = normalizedEmail(address);
    if (!normalized) return "unavailable";
    const digest = emailHash(normalized);
    const code = randomBytes(32).toString("hex");
    const queued = await transaction(pool, async (client) => {
      let principalId: string | undefined;
      if (purpose === "attach") {
        const principal = (
          await client.query<{ id: string }>(
            `SELECT p.id FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
               AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL
             FOR UPDATE OF p`,
            [hash(memberToken!)],
          )
        ).rows[0];
        if (!principal) return false;
        principalId = principal.id;
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [digest],
        );
        const bound = await client.query(
          "SELECT 1 FROM member_email_identities WHERE principal_id=$1 OR email_hash=$2",
          [principalId, digest],
        );
        if (bound.rowCount) return false;
      } else {
        const identity = (
          await client.query<{ principal_id: string }>(
            "SELECT principal_id FROM member_email_identities WHERE email_hash=$1",
            [digest],
          )
        ).rows[0];
        if (!identity) return false;
        const principal = (
          await client.query<{ id: string }>(
            `SELECT p.id FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
             WHERE p.id=$1 AND p.kind='member' AND p.revoked_at IS NULL
               AND w.deleting_at IS NULL FOR UPDATE OF p`,
            [identity.principal_id],
          )
        ).rows[0];
        if (!principal) return false;
        principalId = principal.id;
      }
      // The principal lock also serializes duplicate requests while delivery is
      // in flight. Preserve the usable link instead of replacing inbox messages.
      const pending = await client.query(
        `SELECT 1 FROM member_email_links
         WHERE principal_id=$1 AND email_hash=$2 AND purpose=$3
           AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
        [principalId, digest, purpose],
      );
      if (pending.rowCount) return false;
      const limited = await client.query(
        `SELECT 1 FROM member_email_links
         WHERE (email_hash=$1 OR principal_id=$2)
           AND created_at>clock_timestamp()-INTERVAL '1 hour'
         OFFSET 4 LIMIT 1`,
        [digest, principalId],
      );
      if (limited.rowCount) return false;
      await client.query(
        "UPDATE member_email_links SET consumed_at=clock_timestamp() WHERE principal_id=$1 AND consumed_at IS NULL",
        [principalId],
      );
      await client.query(
        `INSERT INTO member_email_links(token_hash,email_hash,principal_id,purpose,expires_at)
         VALUES($1,$2,$3,$4,clock_timestamp()+INTERVAL '15 minutes')`,
        [hash(code), digest, principalId, purpose],
      );
      return true;
    });
    if (!queued) return "unavailable";
    try {
      await sender.send(
        normalized,
        `${origin}/email/confirm?code=${encodeURIComponent(code)}`,
      );
      return "sent";
    } catch {
      await pool.query(
        "UPDATE member_email_links SET consumed_at=clock_timestamp() WHERE token_hash=$1 AND consumed_at IS NULL",
        [hash(code)],
      );
      return "unavailable";
    }
  }
  return {
    requestAttach: (token, address) => request("attach", address, token),
    async requestSignIn(address) {
      await request("sign_in", address);
    },
    async consume(code, currentToken) {
      if (!/^[a-f0-9]{64}$/.test(code)) return { kind: "unavailable" };
      const result = await transaction(pool, async (client) => {
        const candidate = (
          await client.query<{ principal_id: string }>(
            "SELECT principal_id FROM member_email_links WHERE token_hash=$1",
            [hash(code)],
          )
        ).rows[0];
        if (!candidate) return { kind: "unavailable" as const };
        const principal = (
          await client.query<{ id: string }>(
            `SELECT p.id FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
             WHERE p.id=$1 AND p.kind='member' AND p.revoked_at IS NULL
               AND w.deleting_at IS NULL FOR UPDATE OF p`,
            [candidate.principal_id],
          )
        ).rows[0];
        if (!principal) return { kind: "unavailable" as const };
        if (currentToken) {
          const current = (
            await client.query<{ id: string }>(
              `SELECT id FROM principals WHERE token_hash=$1 AND kind='member'
                 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
              [hash(currentToken)],
            )
          ).rows[0];
          if (current && current.id !== principal.id)
            return { kind: "unavailable" as const };
        }
        const link = (
          await client.query<{
            email_hash: string;
            purpose: EmailPurpose;
          }>(
            `SELECT email_hash,purpose FROM member_email_links
             WHERE token_hash=$1 AND principal_id=$2 AND consumed_at IS NULL
               AND expires_at>clock_timestamp() FOR UPDATE`,
            [hash(code), principal.id],
          )
        ).rows[0];
        if (!link) return { kind: "unavailable" as const };
        if (link.purpose === "attach") {
          const inserted = await client.query(
            `INSERT INTO member_email_identities(email_hash,principal_id)
             VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING principal_id`,
            [link.email_hash, principal.id],
          );
          await client.query(
            "UPDATE member_email_links SET consumed_at=clock_timestamp() WHERE token_hash=$1",
            [hash(code)],
          );
          return inserted.rowCount
            ? { kind: "attached" as const }
            : { kind: "unavailable" as const };
        }
        const bound = await client.query(
          "SELECT 1 FROM member_email_identities WHERE email_hash=$1 AND principal_id=$2",
          [link.email_hash, principal.id],
        );
        if (!bound.rowCount) return { kind: "unavailable" as const };
        const newToken = randomBytes(32).toString("hex");
        const newHash = hash(newToken);
        await client.query(
          `UPDATE principals SET token_hash=$2,expires_at=clock_timestamp()+INTERVAL '30 days'
           WHERE id=$1`,
          [principal.id, newHash],
        );
        await client.query(
          `UPDATE learners SET token_hash=$2,expires_at=(SELECT expires_at FROM principals WHERE id=$1)
           WHERE id=$1`,
          [principal.id, newHash],
        );
        await client.query(
          "UPDATE member_email_links SET consumed_at=clock_timestamp() WHERE principal_id=$1 AND consumed_at IS NULL",
          [principal.id],
        );
        return { kind: "signed_in" as const, token: newToken };
      });
      return result;
    },
  };
}
