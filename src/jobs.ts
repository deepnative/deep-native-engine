import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  validateAdapterResult,
  type AdapterKind,
  type AdapterRegistry,
  type AdapterResult,
  type ApplicationMode,
} from "./adapters.ts";

export type JobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "exhausted"
  | "needs_reconciliation";
export type SafeJobError =
  | "provider_unavailable"
  | "provider_timeout"
  | "invalid_provider_response"
  | "provider_outcome_unknown";

export interface AdapterJob {
  id: string;
  adapter: AdapterKind;
  mode: ApplicationMode;
  operation: string;
  requestFingerprint: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  safeError: SafeJobError | null;
  retryable: boolean;
}

export interface AdapterAttempt extends AdapterJob {
  status: "running";
  attemptToken: string;
}

interface JobRow {
  id: string;
  adapter: AdapterKind;
  mode: ApplicationMode;
  operation: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  safe_error: SafeJobError | null;
  attempt_token: string | null;
}

function job(row: JobRow): AdapterJob {
  return {
    id: row.id,
    adapter: row.adapter,
    mode: row.mode,
    operation: row.operation,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    attempts: row.attempt_count,
    maxAttempts: row.max_attempts,
    safeError: row.safe_error,
    retryable:
      (row.status === "failed" || row.status === "pending") &&
      row.attempt_count < row.max_attempts,
  };
}

function attempt(row: JobRow): AdapterAttempt {
  if (row.status !== "running" || !row.attempt_token)
    throw new Error("Adapter attempt is not active.");
  return { ...job(row), status: "running", attemptToken: row.attempt_token };
}

function validateText(value: string, label: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum)
    throw new Error(`${label} must be between 1 and ${maximum} characters.`);
  return normalized;
}

export function requestFingerprint(input: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(input) ?? "undefined")
    .digest("hex");
}

export interface JobStore {
  enqueue(
    adapter: AdapterKind,
    mode: ApplicationMode,
    operation: string,
    idempotencyKey: string,
    fingerprint: string,
    maxAttempts?: number,
  ): Promise<AdapterJob>;
  find(id: string): Promise<AdapterJob | undefined>;
  claim(id: string): Promise<AdapterAttempt | undefined>;
  fail(
    id: string,
    attemptToken: string,
    safeError: SafeJobError,
  ): Promise<AdapterJob>;
  succeed(id: string, attemptToken: string): Promise<AdapterJob>;
}

export function jobStore(pool: Pool): JobStore {
  async function current(id: string) {
    const row = (
      await pool.query<JobRow>("SELECT * FROM adapter_jobs WHERE id=$1", [id])
    ).rows[0];
    if (!row) throw new Error("Adapter job not found.");
    return job(row);
  }

  return {
    async enqueue(
      adapter,
      mode,
      operation,
      idempotencyKey,
      fingerprint,
      maxAttempts = 3,
    ) {
      const normalizedOperation = validateText(operation, "Job operation", 80);
      const normalizedKey = validateText(
        idempotencyKey,
        "Job idempotency key",
        120,
      );
      if (!/^[a-f0-9]{64}$/.test(fingerprint))
        throw new Error("Job request fingerprint must be a SHA-256 digest.");
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
        throw new Error("Job max attempts must be an integer from 1 to 5.");
      const inserted = await pool.query<JobRow>(
        `INSERT INTO adapter_jobs(
           id,adapter,mode,operation,idempotency_key,request_fingerprint,max_attempts
         ) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(idempotency_key) DO NOTHING
         RETURNING *`,
        [
          randomUUID(),
          adapter,
          mode,
          normalizedOperation,
          normalizedKey,
          fingerprint,
          maxAttempts,
        ],
      );
      const row =
        inserted.rows[0] ??
        (
          await pool.query<JobRow>(
            "SELECT * FROM adapter_jobs WHERE idempotency_key=$1",
            [normalizedKey],
          )
        ).rows[0];
      if (!row) throw new Error("Adapter job could not be enqueued.");
      if (
        row.adapter !== adapter ||
        row.mode !== mode ||
        row.operation !== normalizedOperation ||
        row.request_fingerprint !== fingerprint ||
        row.max_attempts !== maxAttempts
      )
        throw new Error(
          "Job idempotency key was already used for another request.",
        );
      return job(row);
    },
    async find(id) {
      const row = (
        await pool.query<JobRow>("SELECT * FROM adapter_jobs WHERE id=$1", [id])
      ).rows[0];
      return row && job(row);
    },
    async claim(id) {
      const row = (
        await pool.query<JobRow>(
          `WITH exhausted AS (
             UPDATE adapter_jobs
             SET status='exhausted',attempt_token=NULL,lease_until=NULL,
                 updated_at=CURRENT_TIMESTAMP
             WHERE id=$1 AND attempt_count>=max_attempts
               AND (status IN ('pending','failed')
                    OR (adapter<>'ai' AND status='running' AND lease_until<=CURRENT_TIMESTAMP))
           )
           UPDATE adapter_jobs
           SET status=CASE WHEN adapter='ai' AND status='running'
                           THEN 'needs_reconciliation' ELSE 'running' END,
               attempt_count=CASE WHEN adapter='ai' AND status='running'
                                  THEN attempt_count ELSE attempt_count+1 END,
               attempt_token=CASE WHEN adapter='ai' AND status='running'
                                  THEN NULL ELSE $2::uuid END,
               lease_until=CASE WHEN adapter='ai' AND status='running'
                                THEN NULL ELSE CURRENT_TIMESTAMP+INTERVAL '5 minutes' END,
               safe_error=CASE WHEN adapter='ai' AND status='running'
                               THEN 'provider_outcome_unknown' ELSE NULL END,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$1
             AND ((status IN ('pending','failed') AND attempt_count<max_attempts)
                  OR (status='running' AND lease_until<=CURRENT_TIMESTAMP
                      AND (adapter='ai' OR attempt_count<max_attempts)))
           RETURNING *`,
          [id, randomUUID()],
        )
      ).rows[0];
      return row && row.status !== "needs_reconciliation"
        ? attempt(row)
        : undefined;
    },
    async fail(id, attemptToken, safeError) {
      if (
        ![
          "provider_unavailable",
          "provider_timeout",
          "invalid_provider_response",
          "provider_outcome_unknown",
        ].includes(safeError)
      )
        throw new Error("Adapter failure code must be allowlisted.");
      const row = (
        await pool.query<JobRow>(
          `UPDATE adapter_jobs
           SET status=CASE WHEN adapter='ai' AND $3 IN ('provider_timeout','provider_outcome_unknown')
                           THEN 'needs_reconciliation'
                           WHEN attempt_count>=max_attempts
                           THEN 'exhausted' ELSE 'failed' END,
               safe_error=$3,attempt_token=NULL,lease_until=NULL,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND status='running' AND attempt_token=$2
           RETURNING *`,
          [id, attemptToken, safeError],
        )
      ).rows[0];
      return row ? job(row) : current(id);
    },
    async succeed(id, attemptToken) {
      const row = (
        await pool.query<JobRow>(
          `UPDATE adapter_jobs
           SET status='succeeded',safe_error=NULL,attempt_token=NULL,
               lease_until=NULL,updated_at=CURRENT_TIMESTAMP
           WHERE id=$1 AND status='running' AND attempt_token=$2
           RETURNING *`,
          [id, attemptToken],
        )
      ).rows[0];
      return row ? job(row) : current(id);
    },
  };
}

export function enqueueAdapterJob(
  jobs: JobStore,
  registry: AdapterRegistry,
  kind: AdapterKind,
  operation: string,
  input: unknown,
  idempotencyKey: string,
  maxAttempts = 3,
) {
  registry.adapter(kind, registry.mode);
  return jobs.enqueue(
    kind,
    registry.mode,
    operation,
    idempotencyKey,
    requestFingerprint(input),
    maxAttempts,
  );
}

export async function runAdapterJob(
  jobs: JobStore,
  registry: AdapterRegistry,
  id: string,
  input: unknown,
): Promise<{
  job: AdapterJob;
  result: AdapterResult | null;
  executed: boolean;
}> {
  const existing = await jobs.find(id);
  if (!existing) throw new Error("Adapter job not found.");
  const adapter = registry.adapter(existing.adapter, existing.mode);
  if (existing.requestFingerprint !== requestFingerprint(input))
    throw new Error("Adapter job input does not match its enqueued request.");
  const claimed = await jobs.claim(id);
  if (!claimed)
    return {
      job: (await jobs.find(id)) ?? existing,
      result: null,
      executed: false,
    };

  let rawResult: unknown;
  try {
    rawResult = await adapter.execute(claimed.operation, input);
  } catch {
    return {
      job: await jobs.fail(
        claimed.id,
        claimed.attemptToken,
        claimed.adapter === "ai"
          ? "provider_outcome_unknown"
          : "provider_unavailable",
      ),
      result: null,
      executed: true,
    };
  }
  const result =
    claimed.mode === registry.mode
      ? validateAdapterResult(rawResult, claimed.adapter, claimed.mode)
      : null;
  if (!result)
    return {
      job: await jobs.fail(
        claimed.id,
        claimed.attemptToken,
        "invalid_provider_response",
      ),
      result: null,
      executed: true,
    };

  let completed: AdapterJob;
  try {
    completed = await jobs.succeed(claimed.id, claimed.attemptToken);
  } catch {
    const confirmed = await jobs.find(claimed.id).catch(() => undefined);
    if (
      confirmed?.status !== "succeeded" ||
      confirmed.attempts !== claimed.attempts
    )
      throw new Error("Could not confirm adapter job completion.");
    completed = confirmed;
  }
  // Claims monotonically increment attempts; a terminal success cannot be claimed
  // again. Status alone could attribute a replacement worker's success to us.
  return {
    job: completed,
    result:
      completed.status === "succeeded" &&
      completed.attempts === claimed.attempts
        ? result
        : null,
    executed: true,
  };
}
