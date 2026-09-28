import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { it, expect, vi } from "vitest";
import {
  localAiConsentStore,
  disabledLocalAiConsentStore,
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
    source?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
    job?: Record<string, unknown>;
    missing?: string;
    active?: boolean;
    bytes?: Buffer;
    existing?: boolean;
    insertion?: boolean;
    fail?: string;
    broken?: boolean;
    phase2Denied?: boolean;
    invalidPhase2Job?: boolean;
  } = {},
) {
  const s = { ...source, ...options.source },
    r = { ...receipt, ...options.receipt },
    j = { ...job, ...options.job };
  let commits = 0;
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (options.fail && sql.includes(options.fail))
      throw Error("private synthetic database detail");
    if (sql === "ROLLBACK" && options.broken) throw Error("rollback detail");
    if (sql === "COMMIT") {
      commits++;
      return { rows: [] };
    }
    if (sql.includes("SELECT e.id FROM evidence_objects"))
      return { rows: [{ id }] };
    if (sql.includes("SELECT id FROM principals"))
      return {
        rows:
          options.missing === "principal" ||
          options.active === false ||
          (options.phase2Denied && commits > 0)
            ? []
            : [{ id: "member" }],
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
    if (sql.includes("SELECT id,status FROM adapter_jobs"))
      return { rows: [{ id: jid, status: j.status }] };
    if (sql.includes("INSERT INTO adapter_jobs"))
      return { rows: options.insertion === false ? [] : [{ id: jid }] };
    if (sql.includes("SELECT * FROM adapter_jobs"))
      return { rows: options.missing === "collision" ? [] : [j] };
    if (sql.includes("SET status='running'")) {
      j.status = "running";
      j.attempt_token = args[1] as null;
      j.attempt_count++;
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const get = vi.fn(async () => options.bytes ?? data);
  const execute = vi.fn(async () => adapterResult);
  const registry = {
    mode: "test",
    adapter: vi.fn(() => ({ kind: "ai", mode: "test", execute })),
  } as unknown as AdapterRegistry;
  const service = localAiConsentStore(
    { connect } as unknown as Pool,
    { get, put: vi.fn(), remove: vi.fn() },
    registry,
  );
  return { service, query, release, connect, get, execute, registry };
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
    expect(f.release).toHaveBeenCalledWith(false);
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
