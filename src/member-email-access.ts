import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

export type EmailPurpose = "attach" | "sign_in";
export interface MemberEmailSender {
  send(address: string, link: string): Promise<void>;
}
export interface MemberEmailAccess {
  signOut(
    memberToken: string,
    acknowledgeAccessLoss?: boolean,
  ): Promise<"signed_out" | "recovery_required" | "unavailable">;
  ownedStatus(
    memberToken: string,
  ): Promise<"linked" | "unlinked" | "unavailable">;
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

export function emailHash(address: string) {
  return createHash("sha256").update(address).digest("hex");
}

export async function transaction<T>(
  pool: Pool,
  use: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  let discarded = false;
  let commitAttempted = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    const result = await use(client);
    commitAttempted = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (commitAttempted) {
      // A missing acknowledgement does not prove rollback. Discard the client,
      // propagate uncertainty and never replay the operation automatically.
      client.release(new Error("Email access commit outcome uncertain"));
      discarded = true;
      throw error;
    }
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

export async function signOutMember(
  pool: Pool,
  memberToken: string,
  acknowledgeAccessLoss = false,
): ReturnType<MemberEmailAccess["signOut"]> {
  return transaction(pool, async (client) => {
    // Serialize with email sign-in and account deletion before locking any
    // dependent row. PostgreSQL rechecks this exact bearer after a wait.
    const principal = (
      await client.query<{ id: string }>(
        `SELECT id FROM principals WHERE token_hash=$1 AND kind='member'
             AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
        [hash(memberToken)],
      )
    ).rows[0];
    if (!principal) return "unavailable";
    const owner = await client.query(
      `SELECT w.id FROM workspaces w JOIN principals p ON p.id=w.owner_principal_id
           WHERE p.id=$1 AND p.token_hash=$2 AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL FOR UPDATE OF w`,
      [principal.id, hash(memberToken)],
    );
    if (!owner.rowCount) return "unavailable";
    const linked = await client.query(
      "SELECT 1 FROM member_email_identities WHERE principal_id=$1 FOR UPDATE",
      [principal.id],
    );
    // A password with an unverified sign-in email is also a way back.
    const returnable =
      linked.rowCount ||
      (
        await client.query(
          `SELECT 1 FROM member_login_emails e JOIN member_passwords m ON m.principal_id=e.principal_id
           WHERE e.principal_id=$1 FOR UPDATE OF e, m`,
          [principal.id],
        )
      ).rowCount;
    if (!returnable && !acknowledgeAccessLoss) return "recovery_required";
    // No usable replacement bearer leaves this transaction. Keep durable
    // identity, expiry and existing email challenges for deliberate recovery.
    const discardedHash = hash(randomBytes(32).toString("hex"));
    const changed = await client.query(
      "UPDATE principals SET token_hash=$2 WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id",
      [principal.id, discardedHash],
    );
    if (!changed.rowCount) return "unavailable";
    await client.query("UPDATE learners SET token_hash=$2 WHERE id=$1", [
      principal.id,
      discardedHash,
    ]);
    return "signed_out";
  });
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
            `SELECT principal_id FROM member_email_identities WHERE email_hash=$1
             UNION ALL
             SELECT principal_id FROM member_login_emails WHERE email_hash=$1`,
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
    signOut: (token, acknowledgeAccessLoss) =>
      signOutMember(pool, token, acknowledgeAccessLoss),
    async ownedStatus(memberToken) {
      try {
        // Observe only the current active owner's identity. An address is never
        // an input or output of this lookup, including for an unlinked owner.
        const result = await pool.query<{ status: "linked" | "unlinked" }>(
          `SELECT CASE WHEN EXISTS(
             SELECT 1 FROM member_email_identities i WHERE i.principal_id=p.id
           ) THEN 'linked' ELSE 'unlinked' END AS status
           FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
           WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL`,
          [hash(memberToken)],
        );
        return result.rows[0]?.status ?? "unavailable";
      } catch {
        return "unavailable";
      }
    },
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
          // SIGNUP-04: the verified owner of an address wins over any
          // unverified claim to it, and this account's claim is now verified.
          if (inserted.rowCount)
            await client.query(
              "DELETE FROM member_login_emails WHERE email_hash=$1 OR principal_id=$2",
              [link.email_hash, principal.id],
            );
          return inserted.rowCount
            ? { kind: "attached" as const }
            : { kind: "unavailable" as const };
        }
        const bound = await client.query(
          "SELECT 1 FROM member_email_identities WHERE email_hash=$1 AND principal_id=$2",
          [link.email_hash, principal.id],
        );
        if (!bound.rowCount) {
          const claimed = await client.query(
            "DELETE FROM member_login_emails WHERE email_hash=$1 AND principal_id=$2 RETURNING 1",
            [link.email_hash, principal.id],
          );
          if (!claimed.rowCount) return { kind: "unavailable" as const };
          await client.query(
            "INSERT INTO member_email_identities(email_hash,principal_id) VALUES($1,$2)",
            [link.email_hash, principal.id],
          );
        }
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
        // PWD-05: this fresh email session may replace a forgotten password.
        await client.query(
          `INSERT INTO member_password_reset_windows(principal_id,token_hash,expires_at)
           VALUES($1,$2,clock_timestamp()+INTERVAL '30 minutes')
           ON CONFLICT(principal_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at`,
          [principal.id, newHash],
        );
        return { kind: "signed_in" as const, token: newToken };
      });
      return result;
    },
  };
}
