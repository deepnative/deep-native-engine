import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";

export interface UploadAdmissionLimits {
  windowSeconds: number;
  memberUploads: number;
  memberConcurrent: number;
  unauthenticatedUploads: number;
  globalUploads: number;
  globalConcurrent: number;
  leaseSeconds: number;
}
// Team-chosen bounds for the evidence-creating entry points (#315).
export const UPLOAD_ADMISSION_LIMITS: UploadAdmissionLimits = {
  windowSeconds: 600,
  memberUploads: 10,
  memberConcurrent: 2,
  unauthenticatedUploads: 20,
  globalUploads: 200,
  globalConcurrent: 6,
  leaseSeconds: 60,
};
export const CONCURRENCY_RETRY_SECONDS = 5;
export const UNAVAILABLE_RETRY_SECONDS = 60;
// One transaction-scoped lock serializes admission decisions across instances.
const ADMISSION_LOCK = 315_085;

export type DenialReason =
  | "member_rate"
  | "member_concurrency"
  | "unauthenticated_rate"
  | "global_rate"
  | "global_concurrency";
export interface AdmissionCounts {
  member: boolean;
  subjectUploads: number;
  subjectActive: number;
  globalUploads: number;
  globalActive: number;
  secondsLeft: number;
}
export type AdmissionDecision =
  | { kind: "admit" }
  | { kind: "deny"; reason: DenialReason; retryAfterSeconds: number };
export type Admission =
  | { kind: "admitted"; release(): Promise<void> }
  | { kind: "denied"; reason: DenialReason; retryAfterSeconds: number }
  | { kind: "unavailable" };
export interface UploadAdmissionStore {
  admit(token: string): Promise<Admission>;
  denials(): Promise<
    { hourStart: Date; reason: DenialReason; denied: number }[]
  >;
}

export function decide(
  counts: AdmissionCounts,
  limits: UploadAdmissionLimits,
): AdmissionDecision {
  const wait = Math.max(1, Math.ceil(counts.secondsLeft));
  if (counts.member && counts.subjectActive >= limits.memberConcurrent)
    return {
      kind: "deny",
      reason: "member_concurrency",
      retryAfterSeconds: CONCURRENCY_RETRY_SECONDS,
    };
  if (counts.member && counts.subjectUploads >= limits.memberUploads)
    return { kind: "deny", reason: "member_rate", retryAfterSeconds: wait };
  if (!counts.member && counts.subjectUploads >= limits.unauthenticatedUploads)
    return {
      kind: "deny",
      reason: "unauthenticated_rate",
      retryAfterSeconds: wait,
    };
  if (counts.globalActive >= limits.globalConcurrent)
    return {
      kind: "deny",
      reason: "global_concurrency",
      retryAfterSeconds: CONCURRENCY_RETRY_SECONDS,
    };
  if (counts.globalUploads >= limits.globalUploads)
    return { kind: "deny", reason: "global_rate", retryAfterSeconds: wait };
  return { kind: "admit" };
}

const SAVED = "Saved evidence is unchanged.";
// Fixed member-facing refusals; they never include request or member data.
export function refusal(result: Exclude<Admission, { kind: "admitted" }>) {
  if (result.kind === "unavailable")
    return {
      status: 503,
      retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
      error: "uploads_unavailable",
      action: `Uploads are temporarily unavailable. Try again in a minute. ${SAVED}`,
    };
  const seconds = result.retryAfterSeconds;
  const wait = `Wait ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  if (result.reason === "member_concurrency")
    return {
      status: 429,
      retryAfterSeconds: seconds,
      error: "upload_in_progress",
      action: `Wait for your other upload to finish, then try again. ${SAVED}`,
    };
  if (result.reason === "global_concurrency")
    return {
      status: 429,
      retryAfterSeconds: seconds,
      error: "uploads_busy",
      action: `Uploads are busy. ${wait}, then upload again. ${SAVED}`,
    };
  return {
    status: 429,
    retryAfterSeconds: seconds,
    error: "too_many_uploads",
    action: `${wait}, then upload again. ${SAVED}`,
  };
}

interface LeaseRequest {
  socket?: { destroyed: boolean } | null;
}
interface LeaseResponse {
  closed: boolean;
  locals: Record<string, unknown>;
  once(event: "close", listener: () => void): unknown;
}
interface Lease {
  working: boolean;
  release(): Promise<void>;
}
// Keep a concurrency lease until the upload work ends. A response that has
// already closed releases it at once; a later close releases it unless the
// work has started, which then releases it when it finishes.
export async function holdLease(
  req: LeaseRequest,
  res: LeaseResponse,
  release: () => Promise<void>,
  proceed?: () => void,
) {
  // A fully read form body also marks req destroyed; check the connection.
  if (res.closed || !req.socket || req.socket.destroyed) {
    await release();
    return false;
  }
  const lease: Lease = { working: false, release };
  res.locals.uploadLease = lease;
  res.once("close", () => {
    if (!lease.working) void release();
  });
  proceed?.();
  return true;
}
// Admits a copy route's creating request against the shared budget. When it
// returns false it has already answered with the route's own recovery page,
// rendered from the refusal action.
export type AdmitCopy = (
  req: Request,
  res: Response,
  render: (action: string) => string,
) => Promise<boolean>;
export async function underLease<T>(
  res: Pick<LeaseResponse, "locals">,
  work: () => Promise<T>,
) {
  const lease = res.locals.uploadLease as Lease | undefined;
  if (!lease) return work();
  lease.working = true;
  try {
    return await work();
  } finally {
    await lease.release();
  }
}

async function rollback(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
}

export function uploadAdmissionStore(
  pool: Pool,
  limits: UploadAdmissionLimits = UPLOAD_ADMISSION_LIMITS,
): UploadAdmissionStore {
  return {
    async admit(token) {
      let client: PoolClient | undefined, releaseError: Error | undefined;
      try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query(
          "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='3s'; SET LOCAL idle_in_transaction_session_timeout='3s'",
        );
        await client.query("SELECT pg_advisory_xact_lock($1)", [
          ADMISSION_LOCK,
        ]);
        const row = (
          await client.query<{
            principal_id: string | null;
            window_start: Date;
            seconds_left: number;
            subject_uploads: number;
            subject_active: number;
            global_uploads: number;
            global_active: number;
          }>(
            `WITH w AS (
               SELECT clock_timestamp() AS now,
                 to_timestamp(floor(extract(epoch FROM clock_timestamp())/$2)*$2) AS window_start
             ), m AS (
               SELECT p.id FROM principals p, w
               WHERE p.token_hash=$1 AND p.kind='member' AND p.revoked_at IS NULL
                 AND p.expires_at>w.now
             )
             SELECT (SELECT id FROM m) AS principal_id, w.window_start,
               extract(epoch FROM w.window_start+make_interval(secs=>$2)-w.now)::float8 AS seconds_left,
               COALESCE((SELECT x.admitted FROM upload_admission_windows x
                 WHERE x.window_start=w.window_start AND (
                   (x.pool='member' AND x.principal_id=(SELECT id FROM m)) OR
                   (x.pool='unauthenticated' AND NOT EXISTS(SELECT 1 FROM m)))),0) AS subject_uploads,
               (SELECT count(*) FROM upload_admission_leases l
                 WHERE l.principal_id=(SELECT id FROM m) AND l.expires_at>w.now)::int AS subject_active,
               COALESCE((SELECT x.admitted FROM upload_admission_windows x
                 WHERE x.pool='global' AND x.window_start=w.window_start),0) AS global_uploads,
               (SELECT count(*) FROM upload_admission_leases l
                 WHERE l.expires_at>w.now)::int AS global_active
             FROM w`,
            [hash(token), limits.windowSeconds],
          )
        ).rows[0]!;
        const decision = decide(
          {
            member: row.principal_id !== null,
            subjectUploads: row.subject_uploads,
            subjectActive: row.subject_active,
            globalUploads: row.global_uploads,
            globalActive: row.global_active,
            secondsLeft: row.seconds_left,
          },
          limits,
        );
        const lease = randomUUID();
        if (decision.kind === "admit") {
          await client.query(
            `INSERT INTO upload_admission_windows(pool,principal_id,window_start,admitted)
             VALUES('global',NULL,$1,1),($2,$3,$1,1)
             ON CONFLICT(pool,principal_id,window_start)
             DO UPDATE SET admitted=upload_admission_windows.admitted+1`,
            [
              row.window_start,
              row.principal_id === null ? "unauthenticated" : "member",
              row.principal_id,
            ],
          );
          await client.query(
            `INSERT INTO upload_admission_leases(id,principal_id,expires_at)
             VALUES($1,$2,clock_timestamp()+make_interval(secs=>$3))`,
            [lease, row.principal_id, limits.leaseSeconds],
          );
        } else
          await client.query(
            `INSERT INTO upload_admission_denials(hour_start,reason,denied)
             VALUES(date_trunc('hour',clock_timestamp()),$1,1)
             ON CONFLICT(hour_start,reason)
             DO UPDATE SET denied=upload_admission_denials.denied+1`,
            [decision.reason],
          );
        // Bounded retention: windows 1 day, expired leases, denial counts 30 days.
        await client.query(
          `WITH old_windows AS (
             DELETE FROM upload_admission_windows WHERE ctid IN (
               SELECT ctid FROM upload_admission_windows
               WHERE window_start<clock_timestamp()-interval '1 day' LIMIT 100)
           ), old_leases AS (
             DELETE FROM upload_admission_leases WHERE ctid IN (
               SELECT ctid FROM upload_admission_leases
               WHERE expires_at<clock_timestamp() LIMIT 100)
           )
           DELETE FROM upload_admission_denials WHERE ctid IN (
             SELECT ctid FROM upload_admission_denials
             WHERE hour_start<clock_timestamp()-interval '30 days' LIMIT 100)`,
        );
        await client.query("COMMIT");
        if (decision.kind === "deny")
          return {
            kind: "denied",
            reason: decision.reason,
            retryAfterSeconds: decision.retryAfterSeconds,
          };
        let released = false;
        return {
          kind: "admitted",
          async release() {
            if (released) return;
            released = true;
            // An unconfirmed release still expires with its lease.
            await pool
              .query("DELETE FROM upload_admission_leases WHERE id=$1", [lease])
              .catch(() => undefined);
          },
        };
      } catch {
        if (client && !(await rollback(client)))
          releaseError = new Error("Upload admission rollback failed");
        console.error("Upload admission unavailable; uploads are refused.");
        return { kind: "unavailable" };
      } finally {
        client?.release(releaseError);
      }
    },
    async denials() {
      return (
        await pool.query<{
          hourStart: Date;
          reason: DenialReason;
          denied: number;
        }>(
          `SELECT hour_start AS "hourStart",reason,denied
           FROM upload_admission_denials ORDER BY hour_start,reason`,
        )
      ).rows;
    },
  };
}
