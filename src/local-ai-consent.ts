import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hash } from "./store.ts";
import { MAX_EVIDENCE_BYTES, type ObjectStorage } from "./evidence.ts";
import { validateAdapterResult, type AdapterRegistry } from "./adapters.ts";
import { requestFingerprint } from "./jobs.ts";
import { syntheticLedgerOnConnection } from "./ledger.ts";
import { localAiEnabled } from "./local-ai-control.ts";

export const LOCAL_AI_PURPOSE = "evidence-summary-local-v1";
export const LOCAL_AI_STATEMENT_VERSION = "local-simulation-v1";
export const LOCAL_AI_TEST_UNIT_POLICY = "deterministic-request-test-v1";
const MODEL = "deterministic-local-v1";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Denied = { kind: "denied" };
export interface LocalAiChoice {
  evidenceId: string;
  name: string;
  revisionNumber: number;
  receiptId: string | null;
  grantedAt: Date | null;
  withdrawnAt: Date | null;
  jobs: Array<{
    id: string;
    status: string;
    testUnitState?: "reserved" | "consumed" | "released";
  }>;
}
export interface LocalAiConsentStore {
  list(token: string): Promise<LocalAiChoice[]>;
  grant(
    token: string,
    evidenceId: string,
  ): Promise<{ kind: "granted"; receiptId: string } | Denied>;
  withdraw(token: string, receiptId: string): Promise<boolean>;
  enqueue(
    token: string,
    receiptId: string,
    key: string,
  ): Promise<
    { kind: "queued"; jobId: string } | { kind: "denied" | "conflict" }
  >;
  enqueueMetered(
    token: string,
    receiptId: string,
    key: string,
  ): Promise<
    { kind: "queued"; jobId: string } | { kind: "denied" | "conflict" }
  >;
  run(
    token: string,
    jobId: string,
  ): Promise<{
    kind: "completed" | "denied" | "unavailable";
    jobId?: string;
    status?: string;
  }>;
}
export function disabledLocalAiConsentStore(): LocalAiConsentStore {
  return {
    list: async () => [],
    grant: async () => ({ kind: "denied" }),
    withdraw: async () => false,
    enqueue: async () => ({ kind: "denied" }),
    enqueueMetered: async () => ({ kind: "denied" }),
    run: async () => ({ kind: "denied" }),
  };
}
type Source = {
  id: string;
  workspace_id: string;
  owner_principal_id: string;
  original_name: string;
  revision_number: number;
  sha256: string;
  byte_size: number;
  storage_key: string;
};
type Receipt = {
  id: string;
  member_id: string;
  evidence_id: string;
  workspace_id: string;
  revision_number: number;
  source_digest: string;
  purpose: string;
  statement_version: string;
  withdrawn_at: Date | null;
  granted_at: Date;
};
type Job = {
  id: string;
  status: string;
  attempt_token: string | null;
  attempt_count: number;
  lease_expired: boolean;
  local_ai_receipt_id: string;
  member_id: string;
  mode: string;
  adapter: string;
  operation: string;
  test_unit_policy?: string;
  test_unit_reservation?: string;
  request_fingerprint: string;
  prompt_template_version: string;
  model_contract_version: string;
};

export function localAiConsentStore(
  pool: Pool,
  objects: ObjectStorage,
  registry: AdapterRegistry,
): LocalAiConsentStore {
  // Runtime mode is checked even when a caller casts/forges the typed registry.
  if (registry.mode !== "demo" && registry.mode !== "test")
    return disabledLocalAiConsentStore();
  async function transaction<T>(
    fallback: T,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient | undefined;
    let broken = false,
      committed = false,
      commitStarted = false;
    let result: T;
    const connectionFailed = () => {
      broken = true;
    };
    try {
      client = await pool.connect();
      if (typeof client.on === "function") client.on("error", connectionFailed);
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      result = await work(client);
      if (broken) throw Error("Local connection unavailable");
      commitStarted = true;
      await client.query("COMMIT");
      committed = true;
    } catch {
      if (commitStarted) broken = true;
      result = fallback;
    } finally {
      if (client && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
          broken = true;
        }
      }
      try {
        client?.release(broken);
      } catch {
        broken = true;
      }
      // Native pg-pool owns idle errors after release; keep our listener until
      // that handback and withhold a success on any uncertain connection result.
      if (client && typeof client.removeListener === "function") {
        try {
          client.removeListener("error", connectionFailed);
        } catch {
          broken = true;
        }
      }
    }
    return broken ? fallback : result;
  }
  async function active(client: PoolClient, token: string) {
    return Boolean(
      (
        await client.query(
          "SELECT id FROM principals WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL AND expires_at>clock_timestamp()",
          [hash(token)],
        )
      ).rows[0],
    );
  }
  async function source(
    client: PoolClient,
    token: string,
    id: string,
    withdrawing = false,
  ) {
    // Queue/dispatch first lock local control SHARE, then all paths use
    // principal SHARE -> workspace SHARE -> source UPDATE ->
    // receipt UPDATE -> job UPDATE. UPDATE on the source also fences new revisions
    // (their lineage trigger takes SHARE). Recheck the leaf after any lock wait.
    const principal = (
      await client.query<{ id: string }>(
        "SELECT id FROM principals WHERE token_hash=$1 AND kind='member' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE",
        [hash(token)],
      )
    ).rows[0];
    if (!principal) return;
    const workspace = (
      await client.query<{ id: string }>(
        "SELECT id FROM workspaces WHERE owner_principal_id=$1 AND deleting_at IS NULL FOR SHARE",
        [principal.id],
      )
    ).rows[0];
    if (!workspace) return;
    const row = (
      await client.query<Source>(
        `SELECT * FROM evidence_objects WHERE id=$1 AND workspace_id=$2 AND owner_principal_id=$3 ${withdrawing ? "" : "AND quarantine_state='clean' AND media_type='text/plain'"} FOR UPDATE`,
        [id, workspace.id, principal.id],
      )
    ).rows[0];
    if (!row) return;
    if (
      (!withdrawing &&
        (
          await client.query(
            "SELECT id FROM evidence_objects WHERE revision_parent_id=$1",
            [row.id],
          )
        ).rows[0]) ||
      !(await active(client, token))
    )
      return;
    return row;
  }
  async function bytes(row: Source) {
    const data = await objects.get(row.storage_key);
    if (
      data.length !== row.byte_size ||
      data.length > MAX_EVIDENCE_BYTES ||
      createHash("sha256").update(data).digest("hex") !== row.sha256
    )
      return;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (!text.trim() || text.includes("\0")) return;
    return text;
  }
  async function receipt(
    client: PoolClient,
    token: string,
    id: string,
    withdrawing = false,
  ) {
    const hint = (
      await client.query<{ evidence_id: string }>(
        "SELECT evidence_id FROM local_ai_receipts WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!hint) return;
    const row = await source(client, token, hint.evidence_id, withdrawing);
    if (!row) return;
    const permission = (
      await client.query<Receipt>(
        "SELECT * FROM local_ai_receipts WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (
      !permission ||
      permission.member_id !== row.owner_principal_id ||
      permission.workspace_id !== row.workspace_id ||
      permission.evidence_id !== row.id ||
      (!withdrawing &&
        (permission.revision_number !== row.revision_number ||
          permission.source_digest !== row.sha256 ||
          permission.purpose !== LOCAL_AI_PURPOSE ||
          permission.statement_version !== LOCAL_AI_STATEMENT_VERSION ||
          permission.withdrawn_at))
    )
      return;
    return { row, permission };
  }
  const fingerprint = (permission: Receipt, metered = false) =>
    requestFingerprint({
      receiptId: permission.id,
      evidenceId: permission.evidence_id,
      revision: permission.revision_number,
      digest: permission.source_digest,
      purpose: LOCAL_AI_PURPOSE,
      statement: LOCAL_AI_STATEMENT_VERSION,
      model: MODEL,
      mode: registry.mode,
      ...(metered ? { testUnitPolicy: LOCAL_AI_TEST_UNIT_POLICY } : {}),
    });
  async function authorizedJob(client: PoolClient, token: string, id: string) {
    const hint = (
      await client.query<{ local_ai_receipt_id: string }>(
        "SELECT local_ai_receipt_id FROM adapter_jobs WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!hint?.local_ai_receipt_id) return;
    const authorization = await receipt(
      client,
      token,
      hint.local_ai_receipt_id,
    );
    if (!authorization) return;
    const job = (
      await client.query<Job>(
        "SELECT *,lease_until<=clock_timestamp() AS lease_expired FROM adapter_jobs WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!job) return;
    const metering = (
      await client.query<{ policy: string; reservation_id: string }>(
        "SELECT policy,reservation_id FROM local_ai_test_unit_jobs WHERE job_id=$1",
        [id],
      )
    ).rows[0];
    if (metering) {
      if (
        metering.policy !== LOCAL_AI_TEST_UNIT_POLICY ||
        !uuid.test(metering.reservation_id)
      )
        return;
      job.test_unit_policy = metering.policy;
      job.test_unit_reservation = metering.reservation_id;
    }
    if (
      !job ||
      job.member_id !== authorization.permission.member_id ||
      job.local_ai_receipt_id !== authorization.permission.id ||
      job.adapter !== "ai" ||
      job.mode !== registry.mode ||
      job.operation !== LOCAL_AI_PURPOSE ||
      job.prompt_template_version !== LOCAL_AI_STATEMENT_VERSION ||
      job.model_contract_version !== MODEL ||
      job.request_fingerprint !==
        fingerprint(authorization.permission, Boolean(metering)) ||
      !(await active(client, token))
    )
      return;
    return { ...authorization, job };
  }
  async function currentTestReservation(
    client: PoolClient,
    job: Job,
    state: "reserved" | "consumed",
  ) {
    if (!job.test_unit_policy) return true;
    return Boolean(
      (
        await client.query(
          `SELECT 1 FROM local_ai_test_unit_jobs b
       JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id
       JOIN synthetic_entitlement_grants g ON g.id=r.grant_id
       WHERE b.job_id=$1 AND b.member_id=$2 AND b.policy=$3
         AND r.id=$4 AND r.state=$5 AND r.quantity=1 AND g.member_id=$2
         AND g.category='study_requests' AND g.expired_at IS NULL
         AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp()
       FOR UPDATE OF r,g`,
          [
            job.id,
            job.member_id,
            LOCAL_AI_TEST_UNIT_POLICY,
            job.test_unit_reservation,
            state,
          ],
        )
      ).rows[0],
    );
  }
  async function enqueue(
    token: string,
    id: string,
    key: string,
    metered = false,
  ): Promise<Awaited<ReturnType<LocalAiConsentStore["enqueue"]>>> {
    if (!uuid.test(id) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(key))
      return { kind: "denied" };
    return transaction<
      { kind: "queued"; jobId: string } | { kind: "denied" | "conflict" }
    >({ kind: "denied" }, async (client) => {
      if (!(await localAiEnabled(client))) return { kind: "denied" };
      const authorization = await receipt(client, token, id);
      if (
        !authorization ||
        !(await bytes(authorization.row)) ||
        !(await active(client, token))
      )
        return { kind: "denied" };
      const digest = fingerprint(authorization.permission, metered);
      const scopedKey = "local-ai:" + hash(key);
      // receipt() holds UPDATE through commit, serializing every enqueue and
      // local job transition. Existing unresolved rows also fence new keys;
      // exact-key replay below remains available even with legacy duplicates.
      const unresolved = (
        await client.query<{ id: string }>(
          "SELECT id FROM adapter_jobs WHERE local_ai_receipt_id=$1 AND operation=$2 AND status IN ('pending','running','failed','needs_reconciliation') LIMIT 1",
          [id, LOCAL_AI_PURPOSE],
        )
      ).rows[0];
      const prior = (
        await client.query<Job>(
          "SELECT * FROM adapter_jobs WHERE idempotency_key=$1",
          [scopedKey],
        )
      ).rows[0];
      if (prior) {
        return prior.local_ai_receipt_id === id &&
          prior.member_id === authorization.row.owner_principal_id &&
          prior.request_fingerprint === digest
          ? { kind: "queued", jobId: prior.id }
          : { kind: "conflict" };
      }
      if (!unresolved) {
        const selected = metered
          ? (
              await client.query<{ id: string }>(
                `SELECT id FROM synthetic_entitlement_grants WHERE member_id=$1 AND category='study_requests'
             AND available>=1 AND expired_at IS NULL AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp()
             ORDER BY expires_at,id LIMIT 1 FOR UPDATE`,
                [authorization.row.owner_principal_id],
              )
            ).rows[0]
          : undefined;
        if (metered && !selected) return { kind: "denied" };
        const jobId = randomUUID();
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO adapter_jobs(id,member_id,adapter,mode,operation,idempotency_key,request_fingerprint,prompt_template_version,model_contract_version,local_ai_receipt_id,max_attempts) VALUES($1,$2,'ai',$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id",
          [
            jobId,
            authorization.row.owner_principal_id,
            registry.mode,
            LOCAL_AI_PURPOSE,
            scopedKey,
            digest,
            LOCAL_AI_STATEMENT_VERSION,
            MODEL,
            id,
            metered ? 1 : 3,
          ],
        );
        if (inserted.rows[0]) {
          if (metered && selected) {
            const reservationId = await syntheticLedgerOnConnection(
              client,
              jobId,
            ).reserve(
              authorization.row.owner_principal_id,
              selected.id,
              1,
              `local-ai-budget:${jobId}:reserve`,
            );
            await client.query(
              "INSERT INTO local_ai_test_unit_jobs(job_id,member_id,reservation_id,policy) VALUES($1,$2,$3,$4)",
              [
                jobId,
                authorization.row.owner_principal_id,
                reservationId,
                LOCAL_AI_TEST_UNIT_POLICY,
              ],
            );
            if (
              !(await active(client, token)) ||
              !(
                await client.query(
                  "SELECT 1 FROM synthetic_entitlement_grants WHERE id=$1 AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp() AND expired_at IS NULL",
                  [selected.id],
                )
              ).rows[0]
            )
              throw Error("Local test reservation deadline passed");
          }
          return { kind: "queued", jobId: inserted.rows[0].id };
        }
      }
      const existing = (
        await client.query<Job>(
          "SELECT * FROM adapter_jobs WHERE idempotency_key=$1",
          [scopedKey],
        )
      ).rows[0];
      if (
        !existing ||
        existing.local_ai_receipt_id !== id ||
        existing.member_id !== authorization.row.owner_principal_id ||
        existing.request_fingerprint !== digest
      )
        return { kind: "conflict" };
      return { kind: "queued", jobId: existing.id };
    });
  }
  return {
    async list(token) {
      return transaction<LocalAiChoice[]>([], async (client) => {
        const candidates = (
          await client.query<{ id: string }>(
            "SELECT e.id FROM evidence_objects e JOIN principals p ON p.id=e.owner_principal_id WHERE p.token_hash=$1 ORDER BY e.created_at,e.id",
            [hash(token)],
          )
        ).rows;
        const result: LocalAiChoice[] = [];
        for (const candidate of candidates) {
          const row = await source(client, token, candidate.id);
          if (!row || !(await bytes(row))) continue;
          const permission = (
            await client.query<Receipt>(
              "SELECT * FROM local_ai_receipts WHERE evidence_id=$1 ORDER BY granted_at DESC,id DESC LIMIT 1",
              [row.id],
            )
          ).rows[0];
          const jobs = permission
            ? (
                await client.query<{
                  id: string;
                  status: string;
                  policy?: string;
                  test_unit_state?: string;
                }>(
                  "SELECT j.id,j.status,b.policy,r.state AS test_unit_state FROM adapter_jobs j LEFT JOIN local_ai_test_unit_jobs b ON b.job_id=j.id LEFT JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id WHERE j.local_ai_receipt_id=$1 AND j.member_id=$2 ORDER BY j.created_at,j.id",
                  [permission.id, row.owner_principal_id],
                )
              ).rows
            : [];
          result.push({
            evidenceId: row.id,
            name: row.original_name,
            revisionNumber: row.revision_number,
            receiptId:
              permission && !permission.withdrawn_at ? permission.id : null,
            grantedAt: permission?.granted_at ?? null,
            withdrawnAt: permission?.withdrawn_at ?? null,
            jobs: jobs.map((job) => ({
              id: job.id,
              status: job.status,
              ...(job.policy === LOCAL_AI_TEST_UNIT_POLICY &&
              ["reserved", "consumed", "released"].includes(
                job.test_unit_state ?? "",
              )
                ? {
                    testUnitState: job.test_unit_state as
                      "reserved" | "consumed" | "released",
                  }
                : {}),
            })),
          });
        }
        return (await active(client, token)) ? result : [];
      });
    },
    async grant(token, id) {
      if (!uuid.test(id)) return { kind: "denied" };
      return transaction<{ kind: "granted"; receiptId: string } | Denied>(
        { kind: "denied" },
        async (client) => {
          const row = await source(client, token, id);
          if (!row || !(await bytes(row)) || !(await active(client, token)))
            return { kind: "denied" };
          const existing = (
            await client.query<Receipt>(
              "SELECT * FROM local_ai_receipts WHERE evidence_id=$1 AND withdrawn_at IS NULL FOR UPDATE",
              [id],
            )
          ).rows[0];
          if (existing)
            return existing.source_digest === row.sha256 &&
              existing.revision_number === row.revision_number
              ? { kind: "granted", receiptId: existing.id }
              : { kind: "denied" };
          const receiptId = randomUUID();
          await client.query(
            "INSERT INTO local_ai_receipts(id,member_id,workspace_id,evidence_id,revision_number,source_digest,purpose,statement_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              receiptId,
              row.owner_principal_id,
              row.workspace_id,
              id,
              row.revision_number,
              row.sha256,
              LOCAL_AI_PURPOSE,
              LOCAL_AI_STATEMENT_VERSION,
            ],
          );
          return { kind: "granted", receiptId };
        },
      );
    },
    async withdraw(token, id) {
      if (!uuid.test(id)) return false;
      return transaction(false, async (client) => {
        const authorization = await receipt(client, token, id, true);
        if (!authorization || !(await active(client, token))) return false;
        await client.query(
          "UPDATE local_ai_receipts SET withdrawn_at=clock_timestamp() WHERE id=$1 AND withdrawn_at IS NULL",
          [id],
        );
        await client.query(
          "UPDATE adapter_jobs SET status='exhausted',attempt_token=NULL,lease_until=NULL,safe_error='provider_unavailable',updated_at=clock_timestamp() WHERE local_ai_receipt_id=$1 AND status IN ('pending','failed','running')",
          [id],
        );
        return true;
      });
    },
    enqueue: (token, id, key) => enqueue(token, id, key),
    enqueueMetered: (token, id, key) => enqueue(token, id, key, true),
    async run(token, id) {
      if (!uuid.test(id)) return { kind: "denied" };
      // Commit a durable claim BEFORE computation. A crash/ambiguous commit leaves
      // a running attempt; expiry moves it to reconciliation, never auto-reexecution.
      const claim = await transaction<
        { attempt: string } | { status: string } | null
      >(null, async (client) => {
        if (!(await localAiEnabled(client))) return null;
        const authorized = await authorizedJob(client, token, id);
        if (!authorized) return null;
        const { job } = authorized;
        if (job.status === "running" && job.lease_expired) {
          await client.query(
            "UPDATE adapter_jobs SET status='needs_reconciliation',attempt_token=NULL,lease_until=NULL,safe_error='provider_outcome_unknown' WHERE id=$1",
            [id],
          );
          return { status: "needs_reconciliation" };
        }
        if (job.status !== "pending" && job.status !== "failed")
          return { status: job.status };
        if (job.attempt_count >= 3) {
          await client.query(
            "UPDATE adapter_jobs SET status='exhausted',safe_error='invalid_provider_response',updated_at=clock_timestamp() WHERE id=$1",
            [id],
          );
          return { status: "exhausted" };
        }
        if (!(await currentTestReservation(client, job, "reserved")))
          return null;
        const attempt = randomUUID();
        await client.query(
          "UPDATE adapter_jobs SET status='running',attempt_count=attempt_count+1,attempt_token=$2,lease_until=clock_timestamp()+interval '5 minutes',safe_error=NULL,updated_at=clock_timestamp() WHERE id=$1",
          [id, attempt],
        );
        return { attempt };
      });
      if (!claim) return { kind: "denied" };
      if ("status" in claim)
        return {
          kind: claim.status === "succeeded" ? "completed" : "unavailable",
          jobId: id,
          status: claim.status,
        };
      return transaction<{
        kind: "completed" | "denied" | "unavailable";
        jobId?: string;
        status?: string;
      }>({ kind: "unavailable" }, async (client) => {
        // A pause between claim and execution keeps the durable running attempt
        // held. Resume must never reset or replay this uncertain attempt.
        if (!(await localAiEnabled(client))) return { kind: "unavailable" };
        const authorized = await authorizedJob(client, token, id);
        if (
          !authorized ||
          authorized.job.status !== "running" ||
          authorized.job.attempt_token !== claim.attempt
        ) {
          // The only job touched is our durable attempt. Taking this final lock
          // never precedes any further authorization lock, so denial is terminal
          // without exposing state or reversing the global lock order.
          await client.query(
            "UPDATE adapter_jobs SET status='exhausted',attempt_token=NULL,lease_until=NULL,safe_error='provider_unavailable',updated_at=clock_timestamp() WHERE id=$1 AND status='running' AND attempt_token=$2",
            [id, claim.attempt],
          );
          return { kind: "denied" };
        }
        const text = await bytes(authorized.row);
        if (!text || !(await active(client, token))) {
          await client.query(
            "UPDATE adapter_jobs SET status='failed',attempt_token=NULL,lease_until=NULL,safe_error='provider_unavailable' WHERE id=$1",
            [id],
          );
          return { kind: "denied" };
        }
        let result;
        try {
          const adapter = registry.adapter("ai", registry.mode);
          if (adapter.kind !== "ai" || adapter.mode !== registry.mode) {
            await client.query(
              "UPDATE adapter_jobs SET status='exhausted',attempt_token=NULL,lease_until=NULL,safe_error='provider_unavailable',updated_at=clock_timestamp() WHERE id=$1",
              [id],
            );
            return { kind: "denied" };
          }
          result = validateAdapterResult(
            await adapter.execute(LOCAL_AI_PURPOSE, { text }),
            "ai",
            registry.mode,
          );
        } catch {
          await client.query(
            "UPDATE adapter_jobs SET status='needs_reconciliation',attempt_token=NULL,lease_until=NULL,safe_error='provider_outcome_unknown' WHERE id=$1",
            [id],
          );
          return {
            kind: "unavailable",
            jobId: id,
            status: "needs_reconciliation",
          };
        }
        const metered = Boolean(authorized.job.test_unit_policy);
        if (result && metered) {
          const current = (
            await client.query(
              "SELECT 1 FROM adapter_jobs WHERE id=$1 AND status='running' AND attempt_token=$2 AND lease_until>clock_timestamp()",
              [id, claim.attempt],
            )
          ).rows[0];
          if (
            !current ||
            !(await active(client, token)) ||
            !(await currentTestReservation(client, authorized.job, "reserved"))
          ) {
            await client.query(
              "UPDATE adapter_jobs SET status='needs_reconciliation',attempt_token=NULL,lease_until=NULL,safe_error='provider_outcome_unknown',updated_at=clock_timestamp() WHERE id=$1",
              [id],
            );
            return {
              kind: "unavailable",
              jobId: id,
              status: "needs_reconciliation",
            };
          }
          await syntheticLedgerOnConnection(client, id).consume(
            authorized.permission.member_id,
            authorized.job.test_unit_reservation!,
            `local-ai-budget:${id}:consume`,
          );
          // Ledger key/grant waits can outlive the last authorization read.
          // Roll back result and consumption together; the durable claim stays
          // held and cannot be dispatched again after this uncertain boundary.
          if (
            !(await active(client, token)) ||
            !(await currentTestReservation(
              client,
              authorized.job,
              "consumed",
            )) ||
            !(
              await client.query(
                "SELECT 1 FROM adapter_jobs WHERE id=$1 AND status='running' AND attempt_token=$2 AND lease_until>clock_timestamp()",
                [id, claim.attempt],
              )
            ).rows[0]
          )
            throw Error("Local settlement deadline passed");
        }
        const status = result
          ? "succeeded"
          : metered
            ? "needs_reconciliation"
            : "failed";
        // Persist only a server-derived operation token, never provider text.
        await client.query(
          "UPDATE adapter_jobs SET status=$2,attempt_token=NULL,lease_until=NULL,safe_error=$3,provider_operation_reference=$4,updated_at=clock_timestamp() WHERE id=$1",
          [
            id,
            status,
            result
              ? null
              : metered
                ? "provider_outcome_unknown"
                : "invalid_provider_response",
            result ? "local_" + hash(id).slice(0, 24) : null,
          ],
        );
        return {
          kind: result ? "completed" : "unavailable",
          jobId: id,
          status,
        };
      });
    },
  };
}
