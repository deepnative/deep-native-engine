import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * #695 MULTISESSION: an account keeps one sign-in per browser. Each browser's
 * cookie fingerprint has its own member_sessions row, and the account's own
 * token_hash is a random value that no cookie hashes to (migration 099).
 *
 * Every store finds the member with `hash(cookie)`. So that those lookups stay
 * as they are, this process remembers which account a browser currently
 * opens. Each request checks the browser's row again before anything else
 * runs (`openBrowserSession`), and sign-out forgets it at once.
 */
const REMEMBER_MS = 10 * 60_000;
const LIMIT = 50_000;
const opened = new Map<string, { account: string; until: number }>();

/** The fingerprint of one browser's cookie, as stored in member_sessions. */
export function cookieHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** The account a cookie fingerprint opens, or the fingerprint itself. */
export function accountHash(browser: string) {
  const found = opened.get(browser);
  if (!found) return browser;
  if (found.until > Date.now()) return found.account;
  opened.delete(browser);
  return browser;
}

export type Opened = [browser: string, account: string];

/** Call only after the transaction that wrote these rows has committed. */
export function remember(pairs: Opened[]) {
  for (const [browser, account] of pairs) {
    opened.delete(browser);
    opened.set(browser, { account, until: Date.now() + REMEMBER_MS });
    if (opened.size > LIMIT) opened.delete(opened.keys().next().value!);
  }
}

export function forget(browser: string) {
  opened.delete(browser);
}

/**
 * After a commit that replaced an account's value: the browsers that opened
 * `previous` open `account` now, or nothing when their sessions were ended.
 */
export function replaced(previous: string, account?: string) {
  for (const [browser, entry] of opened)
    if (entry.account === previous)
      if (account) entry.account = account;
      else opened.delete(browser);
}

/** Look up this browser's own session before the request reads any record. */
export async function openBrowserSession(pool: Pool, token: string) {
  const browser = cookieHash(token);
  try {
    // A deleted account takes its rows with it; a revoked one still shows as
    // expired, because every lookup checks revoked_at itself.
    const row = (
      await pool.query<{ account: string }>(
        `SELECT p.token_hash AS account FROM member_sessions s
         JOIN principals p ON p.id=s.principal_id
         WHERE s.token_hash=$1 AND p.kind='member' AND s.expires_at>clock_timestamp()`,
        [browser],
      )
    ).rows[0];
    if (row) remember([[browser, row.account]]);
    else forget(browser);
  } catch {
    forget(browser);
  }
}

/**
 * Give an account that still holds one browser's fingerprint its own random
 * value, keeping that browser signed in through a session row.
 */
export async function separateSessions(
  client: PoolClient,
  principalId: string,
): Promise<Opened[]> {
  const current = (
    await client.query<{ token_hash: string; expires_at: Date }>(
      `SELECT token_hash,expires_at FROM principals
       WHERE id=$1 AND kind='member' AND NOT separate_sessions FOR UPDATE`,
      [principalId],
    )
  ).rows[0];
  if (!current) return [];
  await client.query(
    "INSERT INTO member_sessions(token_hash,principal_id,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [current.token_hash, principalId, current.expires_at],
  );
  const { account } = await replaceAccountValue(client, principalId);
  return [[current.token_hash, account]];
}

/**
 * Give the account a new random value. A request still queued behind this
 * transaction then finds no member, as a signed-out browser must; the other
 * browsers find the new value through their own rows on their next request.
 */
export async function replaceAccountValue(
  client: PoolClient,
  principalId: string,
) {
  const previous = (
    await client.query<{ token_hash: string }>(
      "SELECT token_hash FROM principals WHERE id=$1",
      [principalId],
    )
  ).rows[0]!.token_hash;
  const account = cookieHash(randomBytes(32).toString("hex"));
  await client.query(
    "UPDATE principals SET token_hash=$2,separate_sessions=true WHERE id=$1",
    [principalId, account],
  );
  await client.query("UPDATE learners SET token_hash=$2 WHERE id=$1", [
    principalId,
    account,
  ]);
  return { previous, account };
}

/** Sign one more browser in to the account, for 30 days. */
export async function addBrowserSession(
  client: PoolClient,
  principalId: string,
) {
  const moved = await separateSessions(client, principalId);
  const token = randomBytes(32).toString("hex");
  const browser = cookieHash(token);
  await client.query(
    `INSERT INTO member_sessions(token_hash,principal_id,expires_at)
     VALUES($1,$2,clock_timestamp()+INTERVAL '30 days')`,
    [browser, principalId],
  );
  const account = (
    await client.query<{ token_hash: string }>(
      `UPDATE principals SET expires_at=GREATEST(expires_at,clock_timestamp()+INTERVAL '30 days')
       WHERE id=$1 RETURNING token_hash`,
      [principalId],
    )
  ).rows[0]!.token_hash;
  await client.query(
    "UPDATE learners SET expires_at=(SELECT expires_at FROM principals WHERE id=$1) WHERE id=$1",
    [principalId],
  );
  return {
    token,
    opened: [...moved, [browser, account]] as Opened[],
  };
}
