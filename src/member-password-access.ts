import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";
import type { Pool } from "pg";
import {
  emailHash,
  normalizedEmail,
  transaction,
} from "./member-email-access.ts";
import {
  addBrowserSession,
  cookieHash,
  remember,
  replaceAccountValue,
  replaced,
  separateSessions,
  type Opened,
} from "./member-sessions.ts";
import { hash } from "./store.ts";

export type PasswordStatus = "set" | "unset" | "email_required" | "unavailable";
export type PasswordChange =
  | "saved"
  | "invalid"
  | "email_required"
  | "current_required"
  | "current_incorrect"
  | "unavailable";
export type PasswordSignIn =
  { kind: "signed_in"; token: string } | { kind: "refused" | "limited" };
export interface MemberPasswordAccess {
  status(memberToken: string): Promise<PasswordStatus>;
  setPassword(
    memberToken: string,
    password: string,
    current?: string,
  ): Promise<PasswordChange>;
  signIn(email: string, password: string): Promise<PasswordSignIn>;
  /** SIGNUP-01: give an account without any email a sign-in email (verified later) and password. */
  register(
    memberToken: string,
    email: string,
    password: string,
  ): Promise<"saved" | "taken" | "invalid" | "unavailable">;
  /** Whether no account already signs in with this email. */
  emailAvailable(email: string): Promise<boolean>;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
const FAILURE_LIMIT = 5;
const COST = { N: 32768, r: 8, p: 1 } as const;
const KEY_BYTES = 64;

/** A password of 12–128 characters with no control characters. */
export function acceptablePassword(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const characters = Array.from(value);
  return (
    characters.length >= PASSWORD_MIN &&
    characters.length <= PASSWORD_MAX &&
    value.trim().length > 0 &&
    characters.every((c) => c >= " " && c !== "\u007f")
  );
}

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
) => Promise<Buffer>;
function derive(
  password: string,
  salt: Buffer,
  cost: { N: number; r: number; p: number },
) {
  const options: ScryptOptions = {
    ...cost,
    maxmem: 128 * cost.N * cost.r * 2,
  };
  return scrypt(password, salt, KEY_BYTES, options);
}
async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("hex")}$${key.toString("hex")}`;
}
// The stored format is enforced by the member_passwords CHECK constraint.
async function matches(password: string, stored: string) {
  const [, N, r, p, salt, key] = stored.split("$") as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const derived = await derive(password, Buffer.from(salt, "hex"), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  const expected = Buffer.from(key, "hex");
  return timingSafeEqual(derived, expected);
}
// Checked when no account matches, so an unknown email costs the same time.
const absent = hashPassword(randomBytes(24).toString("hex"));

export function memberPasswordAccess(pool: Pool): MemberPasswordAccess {
  async function owner(memberToken: string) {
    return (
      await pool.query<{
        id: string;
        verified: boolean;
        stored: string | null;
      }>(
        `SELECT p.id,
                EXISTS(SELECT 1 FROM member_email_identities i WHERE i.principal_id=p.id)
                  OR EXISTS(SELECT 1 FROM member_login_emails e WHERE e.principal_id=p.id) AS verified,
                (SELECT password_hash FROM member_passwords m WHERE m.principal_id=p.id) AS stored
         FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
         WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
           AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL`,
        [hash(memberToken)],
      )
    ).rows[0];
  }
  return {
    async status(memberToken) {
      try {
        const found = await owner(memberToken);
        if (!found) return "unavailable";
        if (!found.verified) return "email_required";
        return found.stored ? "set" : "unset";
      } catch {
        return "unavailable";
      }
    },
    async setPassword(memberToken, password, current) {
      if (!acceptablePassword(password)) return "invalid";
      const found = await owner(memberToken);
      if (!found) return "unavailable";
      if (!found.verified) return "email_required";
      if (found.stored) {
        const reset = await pool.query(
          `SELECT 1 FROM member_password_reset_windows
           WHERE principal_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp()`,
          [found.id, cookieHash(memberToken)],
        );
        if (!reset.rowCount) {
          if (current === undefined || current === "")
            return "current_required";
          if (!(await matches(current, found.stored)))
            return "current_incorrect";
        }
      }
      const stored = await hashPassword(password);
      let ended: string | undefined;
      let opened: Opened[] = [];
      const changed = await transaction(pool, async (client) => {
        // Recheck the same live owner and sign-in email inside the write.
        const live = await client.query(
          `SELECT p.id FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
           WHERE p.id=$1 AND p.token_hash=$2 AND p.revoked_at IS NULL
             AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL
             AND (EXISTS(SELECT 1 FROM member_email_identities i WHERE i.principal_id=p.id)
               OR EXISTS(SELECT 1 FROM member_login_emails e WHERE e.principal_id=p.id))
           FOR UPDATE OF p`,
          [found.id, hash(memberToken)],
        );
        if (!live.rowCount) return "unavailable" as const;
        await client.query(
          `INSERT INTO member_passwords(principal_id,password_hash) VALUES($1,$2)
           ON CONFLICT(principal_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=clock_timestamp()`,
          [found.id, stored],
        );
        await client.query(
          "DELETE FROM member_password_reset_windows WHERE principal_id=$1",
          [found.id],
        );
        // MULTISESSION-03: a new password signs out every other browser.
        await separateSessions(client, found.id);
        const browser = cookieHash(memberToken);
        await client.query(
          "DELETE FROM member_sessions WHERE principal_id=$1 AND token_hash<>$2",
          [found.id, browser],
        );
        const { previous, account } = await replaceAccountValue(
          client,
          found.id,
        );
        ended = previous;
        opened = [[browser, account]];
        return "saved" as const;
      });
      // The other browsers' sessions ended; this browser opens the new value.
      if (ended) replaced(ended);
      remember(opened);
      return changed;
    },
    async signIn(address, password) {
      const normalized = normalizedEmail(address);
      const digest = emailHash(normalized ?? `invalid:${address}`);
      const recent = await pool.query(
        `SELECT 1 FROM member_password_failures
         WHERE email_hash=$1 AND failed_at>clock_timestamp()-INTERVAL '15 minutes'
         OFFSET ${FAILURE_LIMIT - 1} LIMIT 1`,
        [digest],
      );
      if (recent.rowCount) return { kind: "limited" };
      const candidate = normalized
        ? (
            await pool.query<{ principal_id: string; stored: string }>(
              `SELECT i.principal_id,m.password_hash AS stored
               FROM (SELECT email_hash,principal_id FROM member_email_identities
                     UNION ALL
                     SELECT email_hash,principal_id FROM member_login_emails) i
               JOIN member_passwords m ON m.principal_id=i.principal_id
               WHERE i.email_hash=$1`,
              [digest],
            )
          ).rows[0]
        : undefined;
      const correct =
        password.length > 0 &&
        password.length <= PASSWORD_MAX * 4 &&
        (await matches(password, candidate?.stored ?? (await absent))) &&
        candidate !== undefined;
      if (!correct) {
        await pool.query(
          "INSERT INTO member_password_failures(email_hash) VALUES($1)",
          [digest],
        );
        await pool.query(
          "DELETE FROM member_password_failures WHERE failed_at<clock_timestamp()-INTERVAL '1 day'",
        );
        return { kind: "refused" };
      }
      const signedIn = await transaction(pool, async (client) => {
        const principal = await client.query(
          `SELECT p.id FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
           WHERE p.id=$1 AND p.kind='member' AND p.revoked_at IS NULL
             AND w.deleting_at IS NULL
             AND EXISTS(SELECT 1 FROM member_passwords m WHERE m.principal_id=p.id AND m.password_hash=$2)
           FOR UPDATE OF p`,
          [candidate.principal_id, candidate.stored],
        );
        if (!principal.rowCount) return undefined;
        // MULTISESSION-01: this browser joins any already signed in.
        const added = await addBrowserSession(client, candidate.principal_id);
        await client.query(
          "DELETE FROM member_password_failures WHERE email_hash=$1",
          [digest],
        );
        return added;
      });
      if (!signedIn) return { kind: "refused" };
      remember(signedIn.opened);
      return { kind: "signed_in", token: signedIn.token };
    },
    async emailAvailable(address) {
      const normalized = normalizedEmail(address);
      if (!normalized) return false;
      const taken = await pool.query(
        `SELECT 1 FROM member_email_identities WHERE email_hash=$1
         UNION ALL SELECT 1 FROM member_login_emails WHERE email_hash=$1`,
        [emailHash(normalized)],
      );
      return !taken.rowCount;
    },
    async register(memberToken, address, password) {
      const normalized = normalizedEmail(address);
      if (!normalized || !acceptablePassword(password)) return "invalid";
      const digest = emailHash(normalized);
      const stored = await hashPassword(password);
      let opened: Opened[] = [];
      const registered = await transaction(pool, async (client) => {
        const principal = (
          await client.query<{ id: string }>(
            `SELECT p.id FROM principals p JOIN workspaces w ON w.owner_principal_id=p.id
             WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
               AND p.expires_at>clock_timestamp() AND w.deleting_at IS NULL
               AND NOT EXISTS(SELECT 1 FROM member_email_identities i WHERE i.principal_id=p.id)
               AND NOT EXISTS(SELECT 1 FROM member_login_emails e WHERE e.principal_id=p.id)
             FOR UPDATE OF p`,
            [hash(memberToken)],
          )
        ).rows[0];
        if (!principal) return "unavailable" as const;
        // Serialize with other sign-ups and verifications of this address.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [digest],
        );
        const taken = await client.query(
          `SELECT 1 FROM member_email_identities WHERE email_hash=$1
           UNION ALL SELECT 1 FROM member_login_emails WHERE email_hash=$1`,
          [digest],
        );
        if (taken.rowCount) return "taken" as const;
        await client.query(
          "INSERT INTO member_login_emails(email_hash,principal_id) VALUES($1,$2)",
          [digest, principal.id],
        );
        await client.query(
          `INSERT INTO member_passwords(principal_id,password_hash) VALUES($1,$2)
           ON CONFLICT(principal_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,updated_at=clock_timestamp()`,
          [principal.id, stored],
        );
        // MULTISESSION: an account signs in separately on each browser.
        opened = await separateSessions(client, principal.id);
        return "saved" as const;
      });
      remember(opened);
      return registered;
    },
  };
}
