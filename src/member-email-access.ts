import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  addBrowserSession,
  cookieHash,
  forget,
  remember,
  replaceAccountValue,
  replaced,
  separateSessions,
  type Opened,
} from "./member-sessions.ts";
import { hash } from "./store.ts";
import {
  UNKNOWN_VISITOR,
  type VisitorAddress,
  type VisitorScope,
} from "./visitor-address.ts";

export type EmailPurpose = "attach" | "sign_in";
export interface MemberEmailSender {
  send(address: string, link: string): Promise<void>;
  /** #665: tell an address no account uses how to start. No sign-in link. */
  sendNoAccount?(address: string, startLink: string): Promise<void>;
}
/** Notices to unused addresses, per address, per visitor and in all, in any hour. */
const NOTICE_LIMITS = { perAddress: 1, perVisitor: 3, total: 20 };
// NOTICE-RETAIN-01: long enough for a support lookup, then the hash is gone.
const NOTICE_RETENTION = "30 days";
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
  requestSignIn(address: string, visitor?: VisitorAddress): Promise<void>;
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
  let change: { previous: string; account: string } | undefined;
  let result: Awaited<ReturnType<MemberEmailAccess["signOut"]>>;
  try {
    result = await signOutTransaction(
      pool,
      memberToken,
      acknowledgeAccessLoss,
      (replacement) => (change = replacement),
    );
  } catch (error) {
    // The outcome is uncertain; the next request looks this browser up again.
    forget(cookieHash(memberToken));
    throw error;
  }
  if (result === "signed_out") forget(cookieHash(memberToken));
  // The account's other browsers stay signed in under its new value.
  if (change) replaced(change.previous, change.account);
  return result;
}

function signOutTransaction(
  pool: Pool,
  memberToken: string,
  acknowledgeAccessLoss: boolean,
  onReplace: (replacement: { previous: string; account: string }) => void,
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
    const separate = (
      await client.query<{ separate: boolean }>(
        "SELECT separate_sessions AS separate FROM principals WHERE id=$1",
        [principal.id],
      )
    ).rows[0]!.separate;
    if (separate) {
      // MULTISESSION-02: end this browser's session and its administration;
      // the account's other browsers stay signed in.
      const browser = cookieHash(memberToken);
      // Recheck expiry after the dependent locks, as the bearer change does.
      const ended = await client.query(
        `DELETE FROM member_sessions s USING principals p
         WHERE s.token_hash=$1 AND s.principal_id=$2 AND p.id=s.principal_id
           AND p.expires_at>clock_timestamp()`,
        [browser, principal.id],
      );
      if (!ended.rowCount) return "unavailable";
      await client.query(
        `UPDATE administrator_sessions SET revoked_at=clock_timestamp()
         WHERE member_id=$1 AND member_token_hash=$2 AND revoked_at IS NULL`,
        [principal.id, browser],
      );
      onReplace(await replaceAccountValue(client, principal.id));
      return "signed_out";
    }
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

type RequestOutcome =
  | "sent"
  | "send_failed"
  | "invalid_address"
  | "already_bound"
  | "not_bound"
  | "member_unavailable"
  | "pending"
  | "rate_limited"
  | "no_account_notice"
  | "no_account_limited"
  | "no_account_visitor_limited";
/**
 * EMAIL-DIAG-01: one line an operator can read for each request. It carries no
 * address, hash, link, member identifier or provider message text.
 */
function logRequest(
  purpose: EmailPurpose,
  outcome: RequestOutcome,
  error?: unknown,
  visitorScope?: VisitorScope,
) {
  const line = {
    event: "member_email_request",
    purpose,
    outcome,
    ...(visitorScope ? { visitorScope } : {}),
  };
  if (outcome !== "send_failed") return console.info(JSON.stringify(line));
  const { name, code } = Object(error) as { name?: unknown; code?: unknown };
  console.error(
    JSON.stringify({
      ...line,
      ...(typeof name === "string" && /^\w{1,64}$/.test(name)
        ? { errorName: name }
        : {}),
      ...(typeof code === "string" && /^\w{1,64}$/.test(code)
        ? { errorCode: code }
        : {}),
    }),
  );
}

export function memberEmailAccess(
  pool: Pool,
  sender: MemberEmailSender,
  origin: string,
): MemberEmailAccess {
  // NOTICE-VISITOR-04: IPv4 is small enough to reverse an unkeyed hash, so the
  // key stays in memory. Counts restart with the process; old rows then match
  // nothing and no longer identify anyone.
  const visitorKey = randomBytes(32);
  async function request(
    purpose: EmailPurpose,
    address: string,
    memberToken?: string,
    visitor: VisitorAddress = UNKNOWN_VISITOR,
  ): Promise<"sent" | "unavailable"> {
    const normalized = normalizedEmail(address);
    if (!normalized) {
      logRequest(purpose, "invalid_address");
      return "unavailable";
    }
    const digest = emailHash(normalized);
    const code = randomBytes(32).toString("hex");
    const queued = await transaction<RequestOutcome | "queued">(
      pool,
      async (client) => {
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
          if (!principal) return "member_unavailable";
          principalId = principal.id;
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [digest],
          );
          const bound = await client.query(
            "SELECT 1 FROM member_email_identities WHERE principal_id=$1 OR email_hash=$2",
            [principalId, digest],
          );
          if (bound.rowCount) return "already_bound";
        } else {
          const identity = (
            await client.query<{ principal_id: string }>(
              `SELECT principal_id FROM member_email_identities WHERE email_hash=$1
             UNION ALL
             SELECT principal_id FROM member_login_emails WHERE email_hash=$1`,
              [digest],
            )
          ).rows[0];
          if (!identity) return "not_bound";
          const principal = (
            await client.query<{ id: string }>(
              `SELECT p.id FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
             WHERE p.id=$1 AND p.kind='member' AND p.revoked_at IS NULL
               AND w.deleting_at IS NULL FOR UPDATE OF p`,
              [identity.principal_id],
            )
          ).rows[0];
          if (!principal) return "member_unavailable";
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
        if (pending.rowCount) return "pending";
        const limited = await client.query(
          `SELECT 1 FROM member_email_links
         WHERE (email_hash=$1 OR principal_id=$2)
           AND created_at>clock_timestamp()-INTERVAL '1 hour'
         OFFSET 4 LIMIT 1`,
          [digest, principalId],
        );
        if (limited.rowCount) return "rate_limited";
        await client.query(
          "UPDATE member_email_links SET consumed_at=clock_timestamp() WHERE principal_id=$1 AND consumed_at IS NULL",
          [principalId],
        );
        // SIGNEMAIL-03: an unused link keeps its address only until it
        // expires. Clear expired ones after the member lock, skipping rows
        // another request holds, so this never waits across members.
        await client.query(
          `UPDATE member_email_links SET address=NULL WHERE token_hash IN (
             SELECT token_hash FROM member_email_links
             WHERE address IS NOT NULL AND expires_at<=clock_timestamp()
             FOR UPDATE SKIP LOCKED)`,
        );
        await client.query(
          `INSERT INTO member_email_links(token_hash,email_hash,principal_id,purpose,expires_at,address)
         VALUES($1,$2,$3,$4,clock_timestamp()+INTERVAL '15 minutes',$5)`,
          [hash(code), digest, principalId, purpose, normalized],
        );
        return "queued";
      },
    );
    if (queued === "not_bound" && sender.sendNoAccount) {
      await notice(normalized, digest, visitor);
      return "unavailable";
    }
    if (queued !== "queued") {
      logRequest(purpose, queued);
      return "unavailable";
    }
    try {
      await sender.send(
        normalized,
        `${origin}/email/confirm?code=${encodeURIComponent(code)}`,
      );
      logRequest(purpose, "sent");
      return "sent";
    } catch (error) {
      logRequest(purpose, "send_failed", error);
      await pool.query(
        "UPDATE member_email_links SET consumed_at=clock_timestamp() WHERE token_hash=$1 AND consumed_at IS NULL",
        [hash(code)],
      );
      return "unavailable";
    }
  }
  async function notice(
    address: string,
    digest: string,
    visitor: VisitorAddress,
  ) {
    const visitorHash = createHmac("sha256", visitorKey)
      .update(visitor.key)
      .digest("hex");
    const recorded = await transaction(pool, async (client) => {
      // One lock for every notice keeps all the hourly counts exact.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('member_email_notices',0))",
      );
      // NOTICE-VISITOR-04: these rows have no use once they stop counting.
      await client.query(
        "DELETE FROM member_email_notice_visitors WHERE created_at<=clock_timestamp()-INTERVAL '1 hour'",
      );
      const recent = (
        await client.query<{ total: number; mine: number; visitor: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE email_hash=$1)::int AS mine,
             (SELECT count(*)::int FROM member_email_notice_visitors WHERE visitor_hash=$2) AS visitor
           FROM member_email_notices WHERE created_at>clock_timestamp()-INTERVAL '1 hour'`,
          [digest, visitorHash],
        )
      ).rows[0]!;
      if (
        recent.mine >= NOTICE_LIMITS.perAddress ||
        recent.total >= NOTICE_LIMITS.total
      )
        return "no_account_limited" as const;
      if (recent.visitor >= NOTICE_LIMITS.perVisitor)
        return "no_account_visitor_limited" as const;
      await client.query(
        `DELETE FROM member_email_notices WHERE created_at<clock_timestamp()-INTERVAL '${NOTICE_RETENTION}'`,
      );
      return {
        notice: (
          await client.query<{ id: string }>(
            "INSERT INTO member_email_notices(email_hash) VALUES($1) RETURNING id",
            [digest],
          )
        ).rows[0]!.id,
        visitor: (
          await client.query<{ id: string }>(
            "INSERT INTO member_email_notice_visitors(visitor_hash) VALUES($1) RETURNING id",
            [visitorHash],
          )
        ).rows[0]!.id,
      };
    });
    if (typeof recorded === "string")
      return logRequest("sign_in", recorded, undefined, visitor.scope);
    try {
      await sender.sendNoAccount!(address, `${origin}/`);
      logRequest("sign_in", "no_account_notice", undefined, visitor.scope);
    } catch (error) {
      logRequest("sign_in", "send_failed", error);
      // Nothing reached the inbox, so this request does not count.
      await pool.query("DELETE FROM member_email_notices WHERE id=$1", [
        recorded.notice,
      ]);
      await pool.query("DELETE FROM member_email_notice_visitors WHERE id=$1", [
        recorded.visitor,
      ]);
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
    async requestSignIn(address, visitor) {
      await request("sign_in", address, undefined, visitor);
    },
    async consume(code, currentToken) {
      if (!/^[a-f0-9]{64}$/.test(code)) return { kind: "unavailable" };
      let opened: Opened[] = [];
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
            address: string | null;
          }>(
            `SELECT email_hash,purpose,address FROM member_email_links
             WHERE token_hash=$1 AND principal_id=$2 AND consumed_at IS NULL
               AND expires_at>clock_timestamp() FOR UPDATE`,
            [hash(code), principal.id],
          )
        ).rows[0];
        if (!link) return { kind: "unavailable" as const };
        // SIGNEMAIL-01/02: keep the proven address readable with its
        // fingerprint. Using the link clears it from the link row.
        const address =
          link.address && emailHash(link.address) === link.email_hash
            ? link.address
            : null;
        if (link.purpose === "attach") {
          const inserted = await client.query(
            `INSERT INTO member_email_identities(email_hash,principal_id,address)
             VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING principal_id`,
            [link.email_hash, principal.id, address],
          );
          await client.query(
            "UPDATE member_email_links SET consumed_at=clock_timestamp() WHERE token_hash=$1",
            [hash(code)],
          );
          // SIGNUP-04: the verified owner of an address wins over any
          // unverified claim to it, and this account's claim is now verified.
          if (inserted.rowCount) {
            await client.query(
              "DELETE FROM member_login_emails WHERE email_hash=$1 OR principal_id=$2",
              [link.email_hash, principal.id],
            );
            // MULTISESSION: an account signs in separately on each browser.
            opened = await separateSessions(client, principal.id);
          }
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
            "INSERT INTO member_email_identities(email_hash,principal_id,address) VALUES($1,$2,$3)",
            [link.email_hash, principal.id, address],
          );
        } else if (address)
          await client.query(
            "UPDATE member_email_identities SET address=$3 WHERE email_hash=$1 AND principal_id=$2",
            [link.email_hash, principal.id, address],
          );
        // MULTISESSION-01: this browser joins any already signed in.
        const added = await addBrowserSession(client, principal.id);
        opened = added.opened;
        const newToken = added.token;
        const newHash = cookieHash(newToken);
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
      remember(opened);
      return result;
    },
  };
}
