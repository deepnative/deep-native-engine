import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { it, expect, vi } from "vitest";
import {
  localAiConsentStore,
  disabledLocalAiConsentStore,
  LOCAL_AI_TEST_UNIT_POLICY,
  LOCAL_AI_PURPOSE,
  LOCAL_AI_STATEMENT_VERSION,
} from "../../src/local-ai-consent.ts";
import {
  requestFingerprint,
  jobStore,
  runAdapterJob,
  type JobStore,
} from "../../src/jobs.ts";
import type { AdapterRegistry } from "../../src/adapters.ts";
const id = "00000000-0000-4000-8000-000000000001",
  rid = "00000000-0000-4000-8000-000000000002",
  jid = "00000000-0000-4000-8000-000000000003";
const data = Buffer.from("Invented source");
const source = {
  id,
  workspace_id: "workspace",
  owner_principal_id: "member",
  original_name: "Synthetic.txt",
  revision_number: 1,
  sha256: createHash("sha256").update(data).digest("hex"),
  byte_size: data.length,
  storage_key: "object",
};
const receipt = {
  id: rid,
  member_id: "member",
  workspace_id: "workspace",
  evidence_id: id,
  revision_number: 1,
  source_digest: source.sha256,
  purpose: LOCAL_AI_PURPOSE,
  statement_version: LOCAL_AI_STATEMENT_VERSION,
  granted_at: new Date("2026-01-01"),
  withdrawn_at: null,
};
const digest = requestFingerprint({
  receiptId: rid,
  evidenceId: id,
  revision: 1,
  digest: source.sha256,
  purpose: LOCAL_AI_PURPOSE,
  statement: LOCAL_AI_STATEMENT_VERSION,
  model: "deterministic-local-v1",
  mode: "test",
});
const job = {
  id: jid,
  status: "pending",
  attempt_token: null,
  attempt_count: 0,
  lease_expired: false,
  local_ai_receipt_id: rid,
  member_id: "member",
  mode: "test",
  adapter: "ai",
  operation: LOCAL_AI_PURPOSE,
  request_fingerprint: digest,
  prompt_template_version: LOCAL_AI_STATEMENT_VERSION,
  model_contract_version: "deterministic-local-v1",
};
const adapterResult = {
  kind: "ai",
  mode: "test",
  state: "simulated",
  reference: "test_reference",
  message: "Simulated computation",
};
function setup(
  options: {
    metered?: boolean;
    metering?: Record<string, unknown>;
    noGrant?: boolean;
    budgetDeadline?: "claim" | "before" | "after";
    queueDeadline?: "session" | "grant";
    beforeSettlement?: "session" | "lease";
    concurrentCollision?: boolean;
    legacyClient?: boolean;
    finalDeadline?: "session" | "lease";
    releaseFailure?: boolean;
    listenerFailure?: boolean;
    connectionError?: boolean;
    listedJobs?: Array<Record<string, unknown>>;
    source?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
    job?: Record<string, unknown>;
    missing?: string;
    active?: boolean;
    bytes?: Buffer;
    existing?: boolean;
    insertion?: boolean;
    unresolved?: boolean;
    fail?: string;
    broken?: boolean;
    phase2Denied?: boolean;
    invalidPhase2Job?: boolean;
    paused?: boolean;
    phase2Paused?: boolean;
  } = {},
) {
  const owner = options.metered
    ? "00000000-0000-4000-8000-000000000004"
    : "member";
  const grantId = "00000000-0000-4000-8000-000000000005";
  const reservationId = "00000000-0000-4000-8000-000000000006";
  const s = { ...source, owner_principal_id: owner, ...options.source },
    r = { ...receipt, member_id: owner, ...options.receipt },
    j = {
      ...job,
      member_id: owner,
      ...(options.metered
        ? {
            request_fingerprint: requestFingerprint({
              receiptId: rid,
              evidenceId: id,
              revision: 1,
              digest: source.sha256,
              purpose: LOCAL_AI_PURPOSE,
              statement: LOCAL_AI_STATEMENT_VERSION,
              model: "deterministic-local-v1",
              mode: "test",
              testUnitPolicy: LOCAL_AI_TEST_UNIT_POLICY,
            }),
          }
        : {}),
      ...options.job,
    };
  let settled = false;
  let linkInserted = false,
    outputReady = false,
    priorReads = 0;
  let listener: (() => void) | undefined;
  let commits = 0;
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT 1 FROM local_ai_test_unit_jobs b"))
      return {
        rows:
          options.budgetDeadline === "claim" ||
          (options.budgetDeadline === "before" && outputReady) ||
          (options.budgetDeadline === "after" && settled)
            ? []
            : [{}],
      };
    if (sql.includes("INSERT INTO local_ai_test_unit_jobs"))
      linkInserted = true;
    if (
      sql.includes("UPDATE synthetic_entitlement_grants SET reserved=reserved")
    )
      settled = true;
    if (options.connectionError && sql === "BEGIN") listener?.();
    if (
      sql.includes(
        "SELECT id FROM synthetic_entitlement_grants WHERE member_id",
      )
    )
      return { rows: options.noGrant ? [] : [{ id: grantId }] };
    if (sql.includes("SELECT g.available,g.starts_at"))
      return {
        rows: [
          {
            available: 1,
            starts_at: new Date("2020-01-01"),
            expires_at: new Date("2100-01-01"),
            expired_at: null,
          },
        ],
      };
    if (
      sql.includes("SELECT policy,reservation_id FROM local_ai_test_unit_jobs")
    )
      return {
        rows: options.metered
          ? [
              {
                policy: LOCAL_AI_TEST_UNIT_POLICY,
                reservation_id: reservationId,
                ...options.metering,
              },
            ]
          : [],
      };
    if (sql.includes("SELECT r.grant_id,r.quantity"))
      return {
        rows: [
          {
            grant_id: grantId,
            quantity: 1,
            state: "reserved",
            expires_at: new Date("2100-01-01"),
            expired_at: null,
          },
        ],
      };
    if (sql.includes("SELECT job_id FROM local_ai_test_unit_jobs"))
      return { rows: options.metered ? [{ job_id: jid }] : [] };
    if (sql.includes("SELECT 1 FROM synthetic_entitlement_grants"))
      return {
        rows: options.queueDeadline === "grant" && linkInserted ? [] : [{}],
      };
    if (sql.includes("SELECT 1 FROM adapter_jobs WHERE"))
      return {
        rows:
          (options.finalDeadline === "lease" && settled) ||
          (options.beforeSettlement === "lease" && outputReady)
            ? []
            : [{}],
      };
    if (options.fail && sql.includes(options.fail))
      throw Error("private synthetic database detail");
    if (sql === "ROLLBACK" && options.broken) throw Error("rollback detail");
    if (sql === "COMMIT") {
      commits++;
      return { rows: [] };
    }
    if (sql.includes("SELECT paused FROM local_ai_control"))
      return {
        rows: [
          {
            paused:
              options.paused || (options.phase2Paused && commits > 0) || false,
          },
        ],
      };
    if (sql.includes("SELECT e.id FROM evidence_objects"))
      return { rows: [{ id }] };
    if (sql.includes("SELECT id FROM principals"))
      return {
        rows:
          options.missing === "principal" ||
          options.active === false ||
          (options.finalDeadline === "session" && settled) ||
          (options.queueDeadline === "session" && linkInserted) ||
          (options.beforeSettlement === "session" && outputReady) ||
          (options.phase2Denied && commits > 0)
            ? []
            : [{ id: owner }],
      };
    if (sql.includes("SELECT id FROM workspaces"))
      return {
        rows: options.missing === "workspace" ? [] : [{ id: "workspace" }],
      };
    if (sql.includes("SELECT * FROM evidence_objects"))
      return { rows: options.missing === "source" ? [] : [s] };
    if (sql.includes("SELECT id FROM evidence_objects WHERE revision_parent"))
      return { rows: options.missing === "leaf" ? [{ id: "revision" }] : [] };
    if (sql.includes("SELECT evidence_id FROM local_ai_receipts"))
      return {
        rows: options.missing === "receiptHint" ? [] : [{ evidence_id: id }],
      };
    if (sql.includes("SELECT * FROM local_ai_receipts"))
      return {
        rows:
          options.missing === "receipt" ||
          (sql.includes("withdrawn_at IS NULL") && !options.existing)
            ? []
            : [r],
      };
    if (sql.includes("SELECT local_ai_receipt_id FROM adapter_jobs"))
      return {
        rows:
          options.missing === "jobHint" ? [] : [{ local_ai_receipt_id: rid }],
      };
    if (sql.includes("SELECT *,lease_until"))
      return {
        rows:
          options.missing === "job"
            ? []
            : [
                options.invalidPhase2Job && commits
                  ? { ...j, attempt_token: "wrong" }
                  : j,
              ],
      };
    if (sql.includes("SELECT j.id,j.status,b.policy"))
      return { rows: options.listedJobs ?? [{ id: jid, status: j.status }] };
    if (sql.includes("SELECT id FROM adapter_jobs"))
      return { rows: options.unresolved ? [{ id: jid }] : [] };
    if (sql.includes("INSERT INTO adapter_jobs"))
      return { rows: options.insertion === false ? [] : [{ id: jid }] };
    if (sql.includes("SELECT * FROM adapter_jobs")) {
      priorReads++;
      return {
        rows:
          options.concurrentCollision && priorReads === 1
            ? []
            : options.missing === "collision"
              ? []
              : [j],
      };
    }
    if (sql.includes("SET status='running'")) {
      j.status = "running";
      j.attempt_token = args[1] as null;
      j.attempt_count++;
    }
    return { rows: [] };
  });
  const release = vi.fn(() => {
    if (options.releaseFailure) throw Error("Invented handback error");
  });
  const on = vi.fn((_event: string, callback: () => void) => {
    listener = callback;
  });
  const removeListener = vi.fn(() => {
    if (options.listenerFailure) throw Error("Invented listener failure");
  });
  const connect = vi.fn(async () => ({
    query,
    release,
    on: options.legacyClient ? undefined : on,
    removeListener: options.legacyClient ? undefined : removeListener,
  }));
  const get = vi.fn(async () => options.bytes ?? data);
  const execute = vi.fn(async () => {
    outputReady = true;
    return adapterResult;
  });
  const registry = {
    mode: "test",
    adapter: vi.fn(() => ({ kind: "ai", mode: "test", execute })),
  } as unknown as AdapterRegistry;
  const service = localAiConsentStore(
    { connect } as unknown as Pool,
    { get, put: vi.fn(), remove: vi.fn() },
    registry,
  );
  return {
    service,
    query,
    release,
    connect,
    get,
    execute,
    registry,
    on,
    removeListener,
  };
}
it("disabled and forged live registries never access sources or adapters", async () => {
  for (const service of [
    disabledLocalAiConsentStore(),
    localAiConsentStore(
      {} as Pool,
      {} as never,
      { mode: "live" } as unknown as AdapterRegistry,
    ),
  ]) {
    expect(await service.list("x")).toEqual([]);
    expect(await service.grant("x", id)).toEqual({ kind: "denied" });
    expect(await service.withdraw("x", rid)).toBe(false);
    expect(await service.enqueue("x", rid, "key")).toEqual({ kind: "denied" });
    expect(await service.enqueueMetered("x", rid, "key")).toEqual({
      kind: "denied",
    });
    expect(await service.run("x", jid)).toEqual({ kind: "denied" });
  }
});
it("rejects malformed identifiers and keys before opening storage", async () => {
  const f = setup();
  expect(await f.service.grant("x", "bad")).toEqual({ kind: "denied" });
  expect(await f.service.withdraw("x", "bad")).toBe(false);
  expect(await f.service.run("x", "bad")).toEqual({ kind: "denied" });
  expect(await f.service.enqueue("x", "bad", "key")).toEqual({
    kind: "denied",
  });
  expect(await f.service.enqueue("x", rid, "key with text")).toEqual({
    kind: "denied",
  });
  expect(f.connect).not.toHaveBeenCalled();
});
it("creates an explicit receipt, returns identical grant and never reads provider output into it", async () => {
  const f = setup();
  expect(await f.service.grant("member", id)).toMatchObject({
    kind: "granted",
  });
  expect(f.execute).not.toHaveBeenCalled();
  expect(await setup({ existing: true }).service.grant("member", id)).toEqual({
    kind: "granted",
    receiptId: rid,
  });
  for (const patch of [{ source_digest: "changed" }, { revision_number: 2 }])
    expect(
      await setup({ existing: true, receipt: patch }).service.grant(
        "member",
        id,
      ),
    ).toEqual({ kind: "denied" });
});
it("denies sources unavailable after locks, including expiry and retired sources", async () => {
  for (const missing of ["principal", "workspace", "source", "leaf"]) {
    const f = setup({ missing });
    expect(await f.service.grant("member", id)).toEqual({ kind: "denied" });
    expect(await f.service.list("member")).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  }
  expect(await setup({ active: false }).service.list("member")).toEqual([]);
});
it("verifies exact byte size/digest, bounded nonempty valid UTF8 text and missing objects", async () => {
  for (const bytes of [
    Buffer.from("different"),
    Buffer.alloc(1048577),
    Buffer.from("  "),
    Buffer.from("a\0b"),
    Buffer.from([0xc0, 0xc0]),
  ]) {
    const sourcePatch = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_size: bytes.length,
    };
    const f = setup({
      bytes,
      source: bytes.toString() === "different" ? {} : sourcePatch,
    });
    expect(await f.service.grant("member", id)).toEqual({ kind: "denied" });
    expect(f.execute).not.toHaveBeenCalled();
  }
  const sameSize = setup({ bytes: Buffer.from("Different value") });
  expect(await sameSize.service.grant("member", id)).toEqual({
    kind: "denied",
  });
  const missing = setup();
  missing.get.mockRejectedValueOnce(Error("private path"));
  expect(await missing.service.grant("member", id)).toEqual({ kind: "denied" });
  const listing = setup({ bytes: Buffer.alloc(0) });
  expect(await listing.service.list("member")).toEqual([]);
});
it("returns only owner-safe source summaries, current receipt state and job statuses", async () => {
  expect(await setup().service.list("member")).toMatchObject([
    { receiptId: rid, jobs: [{ id: jid, status: "pending" }] },
  ]);
  expect(
    await setup({ missing: "receipt" }).service.list("member"),
  ).toMatchObject([
    { receiptId: null, grantedAt: null, withdrawnAt: null, jobs: [] },
  ]);
  expect(
    await setup({ receipt: { withdrawn_at: new Date() } }).service.list(
      "member",
    ),
  ).toMatchObject([{ receiptId: null, withdrawnAt: expect.any(Date) }]);
});
it("requires every exact binding and fails closed for unavailable receipt paths", async () => {
  for (const missing of ["receiptHint", "source", "receipt"])
    expect(
      await setup({ missing }).service.enqueue("member", rid, "key"),
    ).toEqual({ kind: "denied" });
  for (const patch of [
    { member_id: "other" },
    { workspace_id: "other" },
    { evidence_id: "other" },
    { revision_number: 2 },
    { source_digest: "other" },
    { purpose: "other" },
    { statement_version: "other" },
    { withdrawn_at: new Date() },
  ]) {
    const f = setup({ receipt: patch });
    expect(await f.service.enqueue("member", rid, "key")).toEqual({
      kind: "denied",
    });
    expect(f.execute).not.toHaveBeenCalled();
  }
});
it("withdraws once and cancels outstanding attempts without invoking the adapter", async () => {
  const f = setup();
  expect(await f.service.withdraw("member", rid)).toBe(true);
  expect(
    f.query.mock.calls.some(([q]) => q.includes("status='exhausted'")),
  ).toBe(true);
  expect(
    await setup({ receipt: { withdrawn_at: new Date() } }).service.withdraw(
      "member",
      rid,
    ),
  ).toBe(true);
  expect(
    await setup({ missing: "receiptHint" }).service.withdraw("member", rid),
  ).toBe(false);
});
it("queues identical requests once and rejects every changed idempotency binding", async () => {
  expect(await setup().service.enqueue("member", rid, "key")).toEqual({
    kind: "queued",
    jobId: jid,
  });
  expect(
    await setup({ insertion: false }).service.enqueue("member", rid, "key"),
  ).toEqual({ kind: "queued", jobId: jid });
  for (const patch of [
    { local_ai_receipt_id: "other" },
    { member_id: "other" },
    { request_fingerprint: "other" },
  ])
    expect(
      await setup({ insertion: false, job: patch }).service.enqueue(
        "member",
        rid,
        "key",
      ),
    ).toEqual({ kind: "conflict" });
  expect(
    await setup({ insertion: false, missing: "collision" }).service.enqueue(
      "member",
      rid,
      "key",
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    await setup({ bytes: Buffer.alloc(0) }).service.enqueue(
      "member",
      rid,
      "key",
    ),
  ).toEqual({ kind: "denied" });
});
it("keeps exact-key replay available while unresolved work fences new or changed keys", async () => {
  expect(
    await setup({ unresolved: true }).service.enqueue("member", rid, "key"),
  ).toEqual({ kind: "queued", jobId: jid });
  for (const options of [
    { missing: "collision" },
    { job: { request_fingerprint: "changed" } },
    { job: { local_ai_receipt_id: "foreign" } },
    { job: { member_id: "foreign" } },
  ]) {
    const f = setup({ unresolved: true, ...options });
    expect(await f.service.enqueue("member", rid, "key")).toEqual({
      kind: "conflict",
    });
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.includes("INSERT INTO adapter_jobs"),
      ),
    ).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  }
});
it("denies enqueue when persisted unresolved state cannot be read", async () => {
  const f = setup({ fail: "SELECT id FROM adapter_jobs" });
  expect(await f.service.enqueue("member", rid, "key")).toEqual({
    kind: "denied",
  });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledWith(false);
});
it("rechecks every job provenance field before claiming, denying legacy, foreign and forged jobs", async () => {
  for (const missing of ["jobHint", "receiptHint", "job"])
    expect(await setup({ missing }).service.run("member", jid)).toEqual({
      kind: "denied",
    });
  for (const patch of [
    { member_id: "other" },
    { local_ai_receipt_id: "other" },
    { adapter: "email" },
    { mode: "demo" },
    { operation: "other" },
    { prompt_template_version: "other" },
    { model_contract_version: "other" },
    { request_fingerprint: "other" },
  ]) {
    const f = setup({ job: patch });
    expect(await f.service.run("member", jid)).toEqual({ kind: "denied" });
    expect(f.execute).not.toHaveBeenCalled();
  }
});
it("persists one claim before bytes reach the adapter and completes with content-free reference", async () => {
  const f = setup();
  expect(await f.service.run("member", jid)).toEqual({
    kind: "completed",
    jobId: jid,
    status: "succeeded",
  });
  expect(f.execute).toHaveBeenCalledWith(LOCAL_AI_PURPOSE, {
    text: data.toString(),
  });
  const completion = f.query.mock.calls.find(([q]) =>
    q.includes("SET status=$2"),
  );
  expect(JSON.stringify(completion)).not.toContain(data.toString());
  expect(JSON.stringify(completion)).not.toContain("Simulated computation");
});
it("keeps succeeded/reconciling/in-flight work idempotent and exhausted attempts bounded", async () => {
  for (const status of [
    "succeeded",
    "needs_reconciliation",
    "running",
    "exhausted",
  ]) {
    const f = setup({ job: { status } });
    expect(await f.service.run("member", jid)).toMatchObject({
      kind: status === "succeeded" ? "completed" : "unavailable",
      status,
    });
    expect(f.execute).not.toHaveBeenCalled();
  }
  expect(
    await setup({ job: { status: "failed" } }).service.run("member", jid),
  ).toMatchObject({ kind: "completed" });
  expect(
    await setup({
      job: { status: "running", lease_expired: true },
    }).service.run("member", jid),
  ).toMatchObject({ status: "needs_reconciliation" });
  expect(
    await setup({ job: { attempt_count: 3 } }).service.run("member", jid),
  ).toMatchObject({ status: "exhausted" });
});
it("terminally fences a claim when authorization or attempt ownership changes between transactions", async () => {
  for (const options of [{ phase2Denied: true }, { invalidPhase2Job: true }]) {
    const f = setup(options);
    expect(await f.service.run("member", jid)).toEqual({ kind: "denied" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      f.query.mock.calls.some(([q]) =>
        q.includes("WHERE id=$1 AND status='running' AND attempt_token=$2"),
      ),
    ).toBe(true);
  }
  const f = setup({ bytes: Buffer.alloc(0) });
  expect(await f.service.run("member", jid)).toEqual({ kind: "denied" });
  expect(f.execute).not.toHaveBeenCalled();
});
it("holds adapter exceptions and treats malformed responses as failed without persisting output", async () => {
  const f = setup();
  f.execute.mockRejectedValueOnce(Error("private provider detail"));
  expect(await f.service.run("member", jid)).toMatchObject({
    status: "needs_reconciliation",
  });
  const invalid = setup();
  invalid.execute.mockResolvedValueOnce({ private: "source" } as never);
  expect(await invalid.service.run("member", jid)).toMatchObject({
    status: "failed",
  });
});
it("sanitizes storage/transaction failures and discards broken clients without erasing durable claims", async () => {
  for (const fail of ["BEGIN", "COMMIT", "SELECT * FROM evidence_objects"]) {
    const f = setup({ fail });
    expect(await f.service.grant("member", id)).toEqual({ kind: "denied" });
    expect(f.release).toHaveBeenCalledWith(fail === "COMMIT");
  }
  const broken = setup({ fail: "BEGIN", broken: true });
  expect(await broken.service.grant("member", id)).toEqual({ kind: "denied" });
  expect(broken.release).toHaveBeenCalledWith(true);
  const unavailable = setup();
  unavailable.connect.mockRejectedValueOnce(Error("private credentials"));
  expect(await unavailable.service.list("member")).toEqual([]);
  expect(unavailable.release).not.toHaveBeenCalled();
});
it("denies generic member AI enqueue and dispatch before generic adapter access", async () => {
  const query = vi.fn();
  await expect(
    jobStore({ query } as unknown as Pool).enqueueForMember(
      "member",
      "ai",
      "test",
      "summary",
      "key",
      "a".repeat(64),
    ),
  ).rejects.toThrow("exact-source");
  expect(query).not.toHaveBeenCalled();
  const generic = {
    find: vi.fn(async () => ({ adapter: "ai", memberId: "member" })),
  } as unknown as JobStore;
  await expect(
    runAdapterJob(generic, setup().registry, jid, {}),
  ).rejects.toThrow("exact-source");
  const mapped = jobStore({
    query: vi.fn(async () => ({ rows: [{ id: jid, member_id: "member" }] })),
  } as unknown as Pool);
  expect(await mapped.find(jid)).toMatchObject({ memberId: "member" });
});

it("allows owner withdrawal independently of leaf status and source version eligibility", async () => {
  const retired = setup({ missing: "leaf" });
  expect(await retired.service.withdraw("member", rid)).toBe(true);
  const changed = setup({ source: { sha256: "changed", revision_number: 2 } });
  expect(await changed.service.withdraw("member", rid)).toBe(true);
  expect(retired.execute).not.toHaveBeenCalled();
  expect(changed.execute).not.toHaveBeenCalled();
});
it("rejects mismatched adapter identity or live mode before delivering any source bytes", async () => {
  for (const fields of [
    { kind: "email", mode: "test" },
    { kind: "ai", mode: "live" },
  ]) {
    const f = setup();
    vi.mocked(f.registry.adapter).mockReturnValue({
      ...fields,
      execute: f.execute,
    } as never);
    expect(await f.service.run("member", jid)).toEqual({ kind: "denied" });
    expect(f.execute).not.toHaveBeenCalled();
  }
});

it("pause denies queue and claim, and preserves a held second-phase attempt", async () => {
  const paused = setup({ paused: true });
  expect(await paused.service.enqueue("member", rid, "key")).toEqual({
    kind: "denied",
  });
  expect(await paused.service.run("member", jid)).toEqual({ kind: "denied" });
  expect(paused.execute).not.toHaveBeenCalled();
  const later = setup({ phase2Paused: true });
  expect(await later.service.run("member", jid)).toEqual({
    kind: "unavailable",
  });
  expect(later.execute).not.toHaveBeenCalled();
  expect(
    later.query.mock.calls.filter(([sql]) =>
      sql.startsWith("UPDATE adapter_jobs"),
    ),
  ).toHaveLength(1);
});

it("metered enqueue reserves one unit in the caller transaction before reporting the queued job", async () => {
  const f = setup({ metered: true, missing: "collision" });
  expect(
    await f.service.enqueueMetered("member", rid, "private-test-key"),
  ).toEqual({ kind: "queued", jobId: jid });
  expect(f.query.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(1);
  expect(f.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(
    1,
  );
  expect(
    f.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO synthetic_entitlement_events"),
    ),
  ).toHaveLength(1);
  expect(f.execute).not.toHaveBeenCalled();
});
it("metered enqueue refuses an absent grant without inserting a job or event", async () => {
  const f = setup({ metered: true, noGrant: true, missing: "collision" });
  expect(
    await f.service.enqueueMetered("member", rid, "private-test-key"),
  ).toEqual({ kind: "denied" });
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO adapter_jobs"),
    ),
  ).toBe(false);
  expect(f.execute).not.toHaveBeenCalled();
});
it("metered queue replay is free while an unmetered contract conflicts", async () => {
  const f = setup({ metered: true, unresolved: true });
  expect(
    await f.service.enqueueMetered("member", rid, "private-test-key"),
  ).toEqual({ kind: "queued", jobId: jid });
  expect(await f.service.enqueue("member", rid, "private-test-key")).toEqual({
    kind: "conflict",
  });
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO synthetic_entitlement_events"),
    ),
  ).toBe(false);
});
it("metered completion settles the held reservation and records no provider text", async () => {
  const f = setup({ metered: true });
  expect(await f.service.run("member", jid)).toEqual({
    kind: "completed",
    jobId: jid,
    status: "succeeded",
  });
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(
    f.query.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO synthetic_entitlement_events"),
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(f.query.mock.calls)).not.toContain(
    "Simulated computation",
  );
});
it.each(["session", "lease"] as const)(
  "a final %s deadline failure rolls back settlement without forgetting the durable claim",
  async (finalDeadline) => {
    const f = setup({ metered: true, finalDeadline });
    expect(await f.service.run("member", jid)).toEqual({ kind: "unavailable" });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(
      1,
    );
    expect(
      f.query.mock.calls.filter(([sql]) => sql === "ROLLBACK"),
    ).toHaveLength(1);
  },
);
it.each([{ policy: "forged" }, { reservation_id: "not-a-reservation" }])(
  "rejects malformed metering provenance before dispatch: %j",
  async (metering) => {
    const f = setup({ metered: true, metering });
    expect(await f.service.run("member", jid)).toEqual({ kind: "denied" });
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it("invalid metered provider output remains unresolved instead of enabling an unmetered retry", async () => {
  const f = setup({ metered: true });
  f.execute.mockResolvedValue({ kind: "invalid" } as never);
  expect(await f.service.run("member", jid)).toEqual({
    kind: "unavailable",
    jobId: jid,
    status: "needs_reconciliation",
  });
  expect(
    f.query.mock.calls.some(([sql]) =>
      sql.includes("INSERT INTO synthetic_entitlement_events"),
    ),
  ).toBe(false);
});
it.each([
  { releaseFailure: true },
  { listenerFailure: true },
  { connectionError: true },
])(
  "contains checked-out client faults without success or a private error: %j",
  async (options) => {
    const f = setup(options);
    expect(await f.service.grant("member", id)).toEqual({ kind: "denied" });
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.removeListener).toHaveBeenCalledTimes(1);
  },
);
it("receipt projection includes only validated local test states", async () => {
  const f = setup({
    listedJobs: [
      {
        id: jid,
        status: "pending",
        policy: LOCAL_AI_TEST_UNIT_POLICY,
        test_unit_state: "reserved",
      },
      {
        id: jid,
        status: "succeeded",
        policy: LOCAL_AI_TEST_UNIT_POLICY,
        test_unit_state: "consumed",
      },
      {
        id: jid,
        status: "exhausted",
        policy: LOCAL_AI_TEST_UNIT_POLICY,
        test_unit_state: "released",
      },
      {
        id: jid,
        status: "pending",
        policy: "forged",
        test_unit_state: "reserved",
      },
      {
        id: jid,
        status: "pending",
        policy: LOCAL_AI_TEST_UNIT_POLICY,
        test_unit_state: "private-secret",
      },
    ],
  });
  expect((await f.service.list("member"))[0]!.jobs).toEqual([
    { id: jid, status: "pending", testUnitState: "reserved" },
    { id: jid, status: "succeeded", testUnitState: "consumed" },
    { id: jid, status: "exhausted", testUnitState: "released" },
    { id: jid, status: "pending" },
    { id: jid, status: "pending" },
  ]);
});

it.each(["session", "grant"] as const)(
  "queue rolls back the new job and hold when its %s deadline passes",
  async (queueDeadline) => {
    const f = setup({ metered: true, missing: "collision", queueDeadline });
    expect(
      await f.service.enqueueMetered("member", rid, "private-key"),
    ).toEqual({ kind: "denied" });
    expect(f.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(f.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it.each(["session", "lease"] as const)(
  "expired %s before settlement retains reconciliation without consuming a unit",
  async (beforeSettlement) => {
    const f = setup({ metered: true, beforeSettlement });
    expect(await f.service.run("member", jid)).toEqual({
      kind: "unavailable",
      jobId: jid,
      status: "needs_reconciliation",
    });
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.includes("UPDATE synthetic_entitlement_grants SET reserved"),
      ),
    ).toBe(false);
  },
);
it("unmetered legacy enqueue creates a job without touching the ledger and accepts a non-emitter test connection", async () => {
  const f = setup({ missing: "collision", legacyClient: true });
  expect(await f.service.enqueue("member", rid, "legacy-key")).toEqual({
    kind: "queued",
    jobId: jid,
  });
  expect(
    f.query.mock.calls.some(([sql]) => sql.includes("synthetic_entitlement")),
  ).toBe(false);
});
it.each([
  {},
  { local_ai_receipt_id: "foreign" },
  { member_id: "foreign" },
  { request_fingerprint: "changed" },
])(
  "a concurrent idempotency winner is revalidated before queue success: %j",
  async (job) => {
    const f = setup({ concurrentCollision: true, insertion: false, job });
    expect(await f.service.enqueue("member", rid, "shared-key")).toEqual(
      Object.keys(job).length
        ? { kind: "conflict" }
        : { kind: "queued", jobId: jid },
    );
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it("a missing linked reservation state is withheld from the receipt projection", async () => {
  const f = setup({
    listedJobs: [
      { id: jid, status: "pending", policy: LOCAL_AI_TEST_UNIT_POLICY },
    ],
  });
  expect((await f.service.list("member"))[0]!.jobs).toEqual([
    { id: jid, status: "pending" },
  ]);
});

it.each(["claim", "before", "after"] as const)(
  "a metered grant deadline at %s cannot publish success or a new charge",
  async (budgetDeadline) => {
    const f = setup({ metered: true, budgetDeadline });
    const result = await f.service.run("member", jid);
    expect(result.kind).toBe(
      budgetDeadline === "claim" ? "denied" : "unavailable",
    );
    expect(f.execute).toHaveBeenCalledTimes(budgetDeadline === "claim" ? 0 : 1);
    if (budgetDeadline === "after")
      expect(f.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  },
);
