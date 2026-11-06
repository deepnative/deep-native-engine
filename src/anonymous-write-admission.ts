import { createHmac } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { VisitorAddress } from "./visitor-address.ts";

export type AnonymousWriteKind = "signup" | "password_sign_in";
export interface AnonymousWriteLimit {
  windowSeconds: number;
  perVisitor: number;
  service: number;
}
export type AnonymousWriteLimits = Record<
  AnonymousWriteKind,
  AnonymousWriteLimit
>;
// Team-chosen bounds (#728). A class or office behind one address must fit in
// the visitor allowance; the service ceiling bounds many addresses together.
export const ANONYMOUS_WRITE_LIMITS: AnonymousWriteLimits = {
  signup: { windowSeconds: 3600, perVisitor: 30, service: 300 },
  password_sign_in: { windowSeconds: 900, perVisitor: 60, service: 1200 },
};
const UNAVAILABLE_RETRY_SECONDS = 60;
const RETENTION = "1 day";
const SERVICE = "service";

export type AnonymousWriteAdmission =
  | { kind: "admitted" }
  | { kind: "refused"; limit: "visitor" | "service"; retryAfterSeconds: number }
  | { kind: "unavailable" };
export interface AnonymousWriteAdmissionStore {
  /** Never rejects: a limiter that cannot answer returns `unavailable`. */
  admit(
    kind: AnonymousWriteKind,
    visitor: VisitorAddress,
  ): Promise<AnonymousWriteAdmission>;
}

const waiting = (seconds: number) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Wait ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
};

// Fixed visitor-facing refusals; they never include request or member data.
export function anonymousWriteRefusal(
  kind: AnonymousWriteKind,
  result: Exclude<AnonymousWriteAdmission, { kind: "admitted" }>,
) {
  const signup = kind === "signup";
  if (result.kind === "unavailable")
    return {
      status: 503,
      retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
      message: signup
        ? "Starting a new account is unavailable right now. Try again in a minute. Nothing was saved."
        : "Sign-in is unavailable right now. Your saved work is unchanged.",
    };
  const wait = waiting(result.retryAfterSeconds);
  const opening = signup
    ? result.limit === "visitor"
      ? "Too many new accounts have been started from this network."
      : "New accounts are busy right now."
    : result.limit === "visitor"
      ? "Too many sign-in attempts from this network."
      : "Sign-in is busy right now.";
  return {
    status: 429,
    retryAfterSeconds: result.retryAfterSeconds,
    message: signup
      ? `${opening} ${wait}, then submit this form again. Nothing was saved.`
      : `${opening} ${wait}, or use an email sign-in link.`,
  };
}

// One atomic step: a row at its allowance is not updated, so nothing comes back
// and concurrent requests cannot pass the allowance together.
async function take(
  client: PoolClient,
  kind: AnonymousWriteKind,
  subject: string,
  windowStart: Date,
  allowance: number,
) {
  const taken = await client.query(
    `INSERT INTO anonymous_write_windows(kind,subject,window_start,admitted)
     VALUES($1,$2,$3,1)
     ON CONFLICT(kind,subject,window_start) DO UPDATE
       SET admitted=anonymous_write_windows.admitted+1
       WHERE anonymous_write_windows.admitted<$4
     RETURNING admitted`,
    [kind, subject, windowStart, allowance],
  );
  return taken.rowCount === 1;
}

/** The stored form of a visitor: keyed, so the address can't be recovered. */
export function anonymousWriteSubject(secret: string, visitor: VisitorAddress) {
  return createHmac("sha256", secret)
    .update(`anonymous-write-visitor|${visitor.key}`)
    .digest("hex");
}

export function anonymousWriteAdmissionStore(
  pool: Pool,
  settings: {
    secret: string;
    /** A local process counts only public addresses; hosted counts everyone. */
    publicOnly: boolean;
  },
  limits: AnonymousWriteLimits = ANONYMOUS_WRITE_LIMITS,
): AnonymousWriteAdmissionStore {
  return {
    async admit(kind, visitor) {
      if (settings.publicOnly && visitor.scope !== "public")
        return { kind: "admitted" };
      const limit = limits[kind];
      let client: PoolClient | undefined, failure: Error | undefined;
      const refuse = async (which: "visitor" | "service", seconds: number) => {
        await client!.query("ROLLBACK");
        console.info(
          JSON.stringify({
            event: "anonymous_write_refused",
            kind,
            limit: which,
            visitorScope: visitor.scope,
          }),
        );
        return {
          kind: "refused",
          limit: which,
          retryAfterSeconds: seconds,
        } as const;
      };
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query(
          "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='3s'; SET LOCAL idle_in_transaction_session_timeout='3s'",
        );
        const window = (
          await client.query<{ window_start: Date; seconds_left: number }>(
            `SELECT w.start AS window_start,
               extract(epoch FROM w.start+make_interval(secs=>$1)-clock_timestamp())::float8 AS seconds_left
             FROM (SELECT to_timestamp(floor(extract(epoch FROM clock_timestamp())/$1)*$1) AS start) w`,
            [limit.windowSeconds],
          )
        ).rows[0]!;
        const seconds = Math.max(1, Math.ceil(window.seconds_left));
        // The visitor comes first: one address past its allowance costs a single
        // row and never waits on the whole-service row.
        if (
          !(await take(
            client,
            kind,
            anonymousWriteSubject(settings.secret, visitor),
            window.window_start,
            limit.perVisitor,
          ))
        )
          return await refuse("visitor", seconds);
        // Rolling back here leaves the visitor's allowance as it was.
        if (
          !(await take(
            client,
            kind,
            SERVICE,
            window.window_start,
            limit.service,
          ))
        )
          return await refuse("service", seconds);
        await client.query(
          `DELETE FROM anonymous_write_windows WHERE window_start<clock_timestamp()-INTERVAL '${RETENTION}'`,
        );
        await client.query("COMMIT");
        return { kind: "admitted" };
      } catch {
        // A connection left in a failed transaction must not return to the pool.
        failure = new Error("Anonymous write admission failed");
        console.error(
          JSON.stringify({ event: "anonymous_write_unavailable", kind }),
        );
        return { kind: "unavailable" };
      } finally {
        client?.release(failure);
      }
    },
  };
}
