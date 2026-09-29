import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { testPool } from "../support/database.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { jobStore, requestFingerprint } from "../../src/jobs.ts";
const pool = testPool();
const db = store(pool);
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals, cohorts CASCADE"));
afterAll(() => pool.end());
async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  return { token, id: session.learner.id };
}
it("denies generic member AI jobs without exact-source permission", async () => {
  const owner = await member();
  await expect(
    jobStore(pool).enqueueForMember(
      owner.token,
      "ai",
      "test",
      "summarize",
      "without-permission",
      requestFingerprint({ synthetic: "private source" }),
      3,
      { promptTemplateVersion: "local-v1", modelContractVersion: "local-v1" },
    ),
  ).rejects.toThrow();
});

import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import {
  deterministicRegistry,
  type AdapterRegistry,
} from "../../src/adapters.ts";
import { runAdapterJob } from "../../src/jobs.ts";
const values = new Map<string, Buffer>();
const objects: ObjectStorage = {
  put: async (k, v) => {
    values.set(k, v);
  },
  get: async (k) => {
    const v = values.get(k);
    if (!v) throw Error("Missing synthetic source");
    return v;
  },
  remove: async (k) => {
    values.delete(k);
  },
};
const evidence = evidenceStore(pool, objects, "synthetic-local-secret");
const registry = deterministicRegistry({}, "test");
const execute = vi.fn(registry.adapter("ai", "test").execute);
const local = localAiConsentStore(pool, objects, {
  mode: "test",
  adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
});
beforeEach(() => {
  values.clear();
  execute.mockReset();
  execute.mockImplementation(registry.adapter("ai", "test").execute);
});
async function fixture(
  owner?: Awaited<ReturnType<typeof member>>,
  revisesId?: string,
  data = "Invented local-only source",
) {
  const person = owner ?? (await member());
  const uploaded = await evidence.upload(person.token, {
    name: "Synthetic.txt",
    mediaType: "text/plain",
    data: Buffer.from(data),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
    ...(revisesId ? { revisesId } : {}),
  });
  if (uploaded.kind !== "created") throw Error("Synthetic upload failed");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  return { ...person, evidenceId: uploaded.id };
}
async function granted() {
  const own = await fixture();
  const permission = await local.grant(own.token, own.evidenceId);
  if (permission.kind !== "granted") throw Error("No synthetic receipt");
  return { ...own, receiptId: permission.receiptId };
}
async function queued() {
  const own = await granted();
  const pending = await local.enqueue(own.token, own.receiptId, randomUUID());
  if (pending.kind !== "queued") throw Error("No synthetic job");
  return { ...own, jobId: pending.jobId };
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Observe the exact dispatch connection, not an unrelated busy session.
function observedDispatch(storage = objects) {
  const backend = { pid: 0 };
  const observedPool = {
    async connect() {
      const client = await pool.connect();
      backend.pid = (
        await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      return client;
    },
  } as unknown as typeof pool;
  return {
    backend,
    service: localAiConsentStore(observedPool, storage, {
      mode: "test",
      adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
    }),
  };
}
async function waitForDispatchBlock(blocker: number, queryPattern: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const waiting = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2",
      [blocker, queryPattern],
    );
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Expected competitor blocked by exact dispatch transaction");
}
it("lists eligible exact sources, persists content-free immutable receipts, and grants idempotently", async () => {
  const own = await fixture();
  expect(await local.list(own.token)).toMatchObject([
    { evidenceId: own.evidenceId, receiptId: null, jobs: [] },
  ]);
  const first = await local.grant(own.token, own.evidenceId);
  expect(await local.grant(own.token, own.evidenceId)).toEqual(first);
  const receipt = (await pool.query("SELECT * FROM local_ai_receipts")).rows[0];
  expect(receipt).toMatchObject({
    member_id: own.id,
    evidence_id: own.evidenceId,
    revision_number: 1,
    purpose: "evidence-summary-local-v1",
    source_digest: createHash("sha256")
      .update("Invented local-only source")
      .digest("hex"),
  });
  expect(JSON.stringify(receipt)).not.toContain("Invented");
  await expect(
    pool.query("UPDATE local_ai_receipts SET source_digest=$1", [
      "a".repeat(64),
    ]),
  ).rejects.toMatchObject({ code: "P0001" });
  expect(await local.list((await member()).token)).toEqual([]);
});
it("queues identical keys once, rejects changed receipt collisions, and persists simulated completion across store restart", async () => {
  const own = await granted();
  const first = await local.enqueue(own.token, own.receiptId, "same-key");
  expect(await local.enqueue(own.token, own.receiptId, "same-key")).toEqual(
    first,
  );
  const other = await granted();
  expect(await local.enqueue(other.token, other.receiptId, "same-key")).toEqual(
    { kind: "conflict" },
  );
  if (first.kind !== "queued") throw Error("No job");
  expect(await local.run(own.token, first.jobId)).toMatchObject({
    kind: "completed",
    status: "succeeded",
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith("evidence-summary-local-v1", {
    text: "Invented local-only source",
  });
  expect(
    await localAiConsentStore(pool, objects, registry).run(
      own.token,
      first.jobId,
    ),
  ).toMatchObject({ kind: "completed" });
  expect(await local.list(own.token)).toMatchObject([
    { jobs: [{ id: first.jobId, status: "succeeded" }] },
  ]);
  expect(
    JSON.stringify((await pool.query("SELECT * FROM adapter_jobs")).rows),
  ).not.toContain("Invented");
});
it("rejects a distinct key while the exact receipt has an unresolved job", async () => {
  const own = await granted();
  const first = await local.enqueue(own.token, own.receiptId, "first-key");
  expect(first.kind).toBe("queued");
  expect(await local.enqueue(own.token, own.receiptId, "second-key")).toEqual({
    kind: "conflict",
  });
  expect(await local.enqueue(own.token, own.receiptId, "first-key")).toEqual(
    first,
  );
  const differentMode = localAiConsentStore(
    pool,
    objects,
    deterministicRegistry({}, "demo"),
  );
  expect(
    await differentMode.enqueue(own.token, own.receiptId, "first-key"),
  ).toEqual({ kind: "conflict" });
  expect(
    await differentMode.enqueue(own.token, own.receiptId, "demo-new-key"),
  ).toEqual({ kind: "conflict" });
  expect(
    (
      await pool.query(
        "SELECT id FROM adapter_jobs WHERE local_ai_receipt_id=$1",
        [own.receiptId],
      )
    ).rowCount,
  ).toBe(1);
  expect(execute).not.toHaveBeenCalled();
});
it.each(["running", "failed", "needs_reconciliation"])(
  "keeps %s work fenced across a new connection pool and preserves exact-key replay",
  async (status) => {
    const own = await granted();
    const first = await local.enqueue(own.token, own.receiptId, "original-key");
    if (first.kind !== "queued") throw Error("No synthetic job");
    if (status === "running") {
      // A durable attempt left by an interrupted worker has an unknown outcome.
      await pool.query(
        "UPDATE adapter_jobs SET status='running',attempt_token=$2,attempt_count=1,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [first.jobId, randomUUID()],
      );
    } else {
      if (status === "failed")
        execute.mockResolvedValueOnce({ invalid: true } as never);
      else execute.mockRejectedValueOnce(Error("synthetic unknown outcome"));
      expect(await local.run(own.token, first.jobId)).toMatchObject({ status });
    }
    const restartedPool = testPool();
    const restarted = localAiConsentStore(restartedPool, objects, registry);
    try {
      expect(
        await restarted.enqueue(own.token, own.receiptId, "different-key"),
      ).toEqual({ kind: "conflict" });
      expect(
        await restarted.enqueue(own.token, own.receiptId, "original-key"),
      ).toEqual(first);
      expect(
        (
          await pool.query(
            "SELECT id,status FROM adapter_jobs WHERE local_ai_receipt_id=$1",
            [own.receiptId],
          )
        ).rows,
      ).toEqual([{ id: first.jobId, status }]);
      expect(execute).toHaveBeenCalledTimes(status === "running" ? 0 : 1);
      if (status === "running" || status === "needs_reconciliation") {
        expect(await local.run(own.token, first.jobId)).toMatchObject({
          status: "needs_reconciliation",
        });
        expect(
          await restarted.enqueue(own.token, own.receiptId, "another-key"),
        ).toEqual({ kind: "conflict" });
        expect(execute).toHaveBeenCalledTimes(status === "running" ? 0 : 1);
      }
    } finally {
      await restartedPool.end();
    }
  },
);
it("serializes simultaneous distinct keys from separate stores to one unresolved job", async () => {
  const own = await granted();
  const entered = latch(),
    release = latch();
  const observed = observedDispatch({
    ...objects,
    get: async (key) => {
      entered.resolve();
      await release.promise;
      return objects.get(key);
    },
  });
  const first = observed.service.enqueue(
    own.token,
    own.receiptId,
    "race-first",
  );
  await entered.promise;
  const secondPool = testPool();
  const second = localAiConsentStore(secondPool, objects, registry).enqueue(
    own.token,
    own.receiptId,
    "race-second",
  );
  try {
    await waitForDispatchBlock(
      observed.backend.pid,
      "SELECT * FROM evidence_objects%FOR UPDATE",
    );
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    await secondPool.end();
  }
  const winner = await first;
  if (winner.kind !== "queued") throw Error("No synthetic race winner");
  expect(await second).toEqual({ kind: "conflict" });
  expect(
    (
      await pool.query(
        "SELECT id,status FROM adapter_jobs WHERE local_ai_receipt_id=$1",
        [own.receiptId],
      )
    ).rows,
  ).toEqual([{ id: winner.jobId, status: "pending" }]);
  expect(execute).not.toHaveBeenCalled();
});
it.each(["succeeded", "exhausted"])(
  "allows a new key after %s while retaining replay of the terminal job",
  async (status) => {
    const own = await granted();
    const first = await local.enqueue(own.token, own.receiptId, "terminal-key");
    if (first.kind !== "queued") throw Error("No synthetic job");
    if (status === "exhausted") {
      execute.mockResolvedValue({ invalid: true } as never);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await local.run(own.token, first.jobId)).toMatchObject({
          status: "failed",
        });
        expect(
          await local.enqueue(own.token, own.receiptId, "premature-key"),
        ).toEqual({ kind: "conflict" });
      }
    }
    expect(await local.run(own.token, first.jobId)).toMatchObject({ status });
    const next = await local.enqueue(own.token, own.receiptId, "next-key");
    expect(next.kind).toBe("queued");
    expect(next).not.toEqual(first);
    expect(
      await local.enqueue(own.token, own.receiptId, "terminal-key"),
    ).toEqual(first);
    expect(await local.enqueue(own.token, own.receiptId, "third-key")).toEqual({
      kind: "conflict",
    });
    expect(
      (
        await pool.query(
          "SELECT status FROM adapter_jobs WHERE local_ai_receipt_id=$1 ORDER BY created_at,id",
          [own.receiptId],
        )
      ).rows,
    ).toEqual([{ status }, { status: "pending" }]);
  },
);
it("fences legacy duplicate rows without hiding exact replay or rewriting unknown outcomes", async () => {
  const own = await granted();
  const first = await local.enqueue(own.token, own.receiptId, "legacy-first");
  if (first.kind !== "queued") throw Error("No synthetic job");
  const legacyId = randomUUID();
  await pool.query(
    "INSERT INTO adapter_jobs(id,member_id,adapter,mode,operation,idempotency_key,request_fingerprint,prompt_template_version,model_contract_version,local_ai_receipt_id,status,safe_error) SELECT $1,member_id,adapter,mode,operation,$2,request_fingerprint,prompt_template_version,model_contract_version,local_ai_receipt_id,'needs_reconciliation','provider_outcome_unknown' FROM adapter_jobs WHERE id=$3",
    [legacyId, "local-ai:" + hash("legacy-held"), first.jobId],
  );
  expect(await local.enqueue(own.token, own.receiptId, "legacy-first")).toEqual(
    first,
  );
  expect(await local.enqueue(own.token, own.receiptId, "legacy-held")).toEqual({
    kind: "queued",
    jobId: legacyId,
  });
  expect(await local.enqueue(own.token, own.receiptId, "new-key")).toEqual({
    kind: "conflict",
  });
  expect(await local.run(own.token, first.jobId)).toMatchObject({
    status: "succeeded",
  });
  expect(
    await local.enqueue(own.token, own.receiptId, "after-success"),
  ).toEqual({
    kind: "conflict",
  });
  expect(await local.run(own.token, legacyId)).toMatchObject({
    status: "needs_reconciliation",
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    (
      await pool.query(
        "SELECT id,status FROM adapter_jobs WHERE local_ai_receipt_id=$1 ORDER BY created_at,id",
        [own.receiptId],
      )
    ).rows,
  ).toEqual([
    { id: first.jobId, status: "succeeded" },
    { id: legacyId, status: "needs_reconciliation" },
  ]);
});
it.each([
  "withdrawal",
  "revision",
  "source deletion",
  "member deletion",
  "expired session",
  "revoked session",
  "platform pause",
  "cross-member access",
])(
  "rechecks %s before enqueue after a known terminal result",
  async (boundary) => {
    const own = await queued();
    expect(await local.run(own.token, own.jobId)).toMatchObject({
      status: "succeeded",
    });
    let token = own.token;
    if (boundary === "withdrawal")
      expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
    else if (boundary === "revision") {
      await evidence.submitForReview(own.token, own.evidenceId);
      await fixture(own, own.evidenceId, "Invented new source");
    } else if (boundary === "source deletion")
      await evidence.remove(own.token, own.evidenceId);
    else if (boundary === "member deletion") {
      await evidence.removeWorkspace(own.token);
      await db.remove(own.id);
    } else if (boundary === "expired session")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
        [own.id],
      );
    else if (boundary === "revoked session")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [own.id],
      );
    else if (boundary === "platform pause")
      await pool.query(
        "UPDATE local_ai_control SET paused=true WHERE singleton=true",
      );
    else token = (await member()).token;
    expect(await local.enqueue(token, own.receiptId, "after-terminal")).toEqual(
      {
        kind: "denied",
      },
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT id FROM adapter_jobs WHERE local_ai_receipt_id=$1 AND status<>'succeeded'",
          [own.receiptId],
        )
      ).rows,
    ).toEqual([]);
  },
);
it("denies generic execution of legacy member AI rows before adapter lookup or execution", async () => {
  const own = await member();
  const jobs = jobStore(pool);
  const input = { synthetic: "legacy" };
  const job = await jobs.enqueue(
    "ai",
    "test",
    "summarize",
    "legacy",
    requestFingerprint(input),
    3,
    { promptTemplateVersion: "v1", modelContractVersion: "v1" },
  );
  await pool.query("UPDATE adapter_jobs SET member_id=$1 WHERE id=$2", [
    own.id,
    job.id,
  ]);
  await expect(
    runAdapterJob(
      jobs,
      {
        mode: "test",
        adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
      },
      job.id,
      input,
    ),
  ).rejects.toThrow("exact-source");
  expect(execute).not.toHaveBeenCalled();
  expect((await jobs.find(job.id))?.status).toBe("pending");
});
it("rejects forged ownership, expired/revoked sessions and generic reviewer consent", async () => {
  const own = await queued();
  const other = await member();
  expect(await local.grant(other.token, own.evidenceId)).toEqual({
    kind: "denied",
  });
  expect(await local.withdraw(other.token, own.receiptId)).toBe(false);
  expect(await local.enqueue(other.token, own.receiptId, "outsider")).toEqual({
    kind: "denied",
  });
  expect(await local.run(other.token, own.jobId)).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [own.id],
  );
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 day',revoked_at=clock_timestamp() WHERE id=$1",
    [own.id],
  );
  expect(await local.grant(own.token, own.evidenceId)).toEqual({
    kind: "denied",
  });
  expect(execute).not.toHaveBeenCalled();
});
it("withdrawal is durable, idempotent, irreversible and does not carry to a new grant", async () => {
  const own = await queued();
  expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
  expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(await local.enqueue(own.token, own.receiptId, "withdrawn")).toEqual({
    kind: "denied",
  });
  await expect(
    pool.query("UPDATE local_ai_receipts SET withdrawn_at=NULL WHERE id=$1", [
      own.receiptId,
    ]),
  ).rejects.toMatchObject({ code: "P0001" });
  const replacement = await local.grant(own.token, own.evidenceId);
  expect(replacement).not.toEqual({
    kind: "granted",
    receiptId: own.receiptId,
  });
  expect(execute).not.toHaveBeenCalled();
});
it("a new revision retires the old source without inheriting AI permission", async () => {
  const own = await queued();
  await evidence.submitForReview(own.token, own.evidenceId);
  const next = await fixture(own, own.evidenceId, "Invented revision");
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(await local.grant(own.token, own.evidenceId)).toEqual({
    kind: "denied",
  });
  expect(await local.list(own.token)).toMatchObject([
    { evidenceId: next.evidenceId, receiptId: null },
  ]);
  expect(execute).not.toHaveBeenCalled();
});
it("fails closed for unavailable, blank, changed and invalid source bytes and rejected/deleting states", async () => {
  for (const text of ["   ", "Invented text"]) {
    const own = await fixture(undefined, undefined, text);
    if (!text.trim()) {
      expect(await local.grant(own.token, own.evidenceId)).toEqual({
        kind: "denied",
      });
      continue;
    }
    const row = (
      await pool.query("SELECT storage_key FROM evidence_objects WHERE id=$1", [
        own.evidenceId,
      ])
    ).rows[0];
    values.set(row.storage_key, Buffer.from("different"));
    expect(await local.grant(own.token, own.evidenceId)).toEqual({
      kind: "denied",
    });
  }
  const own = await queued();
  await pool.query(
    "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1",
    [own.evidenceId],
  );
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
});
it("holds ambiguous adapter failure and expired running claims without redispatch", async () => {
  const own = await queued();
  execute.mockRejectedValueOnce(Error("synthetic private provider error"));
  expect(await local.run(own.token, own.jobId)).toMatchObject({
    kind: "unavailable",
    status: "needs_reconciliation",
  });
  expect(await local.run(own.token, own.jobId)).toMatchObject({
    status: "needs_reconciliation",
  });
  expect(execute).toHaveBeenCalledTimes(1);
  const second = await queued();
  await pool.query(
    "UPDATE adapter_jobs SET status='running',attempt_token=$2,attempt_count=1,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [second.jobId, randomUUID()],
  );
  expect(await local.run(second.token, second.jobId)).toMatchObject({
    status: "needs_reconciliation",
  });
  expect(execute).toHaveBeenCalledTimes(1);
});
it("dispatch wins before withdrawal: one committed computation, then no future execution", async () => {
  const own = await queued();
  const entered = latch(),
    release = latch();
  execute.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return registry.adapter("ai", "test").execute(...args);
  });
  const observed = observedDispatch();
  const running = observed.service.run(own.token, own.jobId);
  await entered.promise;
  const withdrawing = local.withdraw(own.token, own.receiptId);
  try {
    await waitForDispatchBlock(
      observed.backend.pid,
      "SELECT * FROM evidence_objects%FOR UPDATE",
    );
    expect(
      (
        await pool.query(
          "SELECT withdrawn_at FROM local_ai_receipts WHERE id=$1",
          [own.receiptId],
        )
      ).rows[0].withdrawn_at,
    ).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled([running, withdrawing]);
  }
  expect(await running).toMatchObject({ status: "succeeded" });
  expect(await withdrawing).toBe(true);
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(execute).toHaveBeenCalledTimes(1);
});
it("withdrawal wins a receipt wait: dispatch makes zero adapter calls", async () => {
  const own = await queued();
  const c = await pool.connect();
  await c.query("BEGIN");
  await c.query(
    "UPDATE local_ai_receipts SET withdrawn_at=clock_timestamp() WHERE id=$1",
    [own.receiptId],
  );
  const running = local.run(own.token, own.jobId);
  await c.query("COMMIT");
  c.release();
  expect(await running).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
});
it("workspace deletion wins before dispatch and cascade erases receipts/jobs without affecting another member", async () => {
  const own = await queued(),
    other = await queued();
  await evidence.removeWorkspace(own.token);
  await db.remove(own.id);
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect((await pool.query("SELECT id FROM local_ai_receipts")).rows).toEqual([
    { id: other.receiptId },
  ]);
  expect((await pool.query("SELECT id FROM adapter_jobs")).rows).toEqual([
    { id: other.jobId },
  ]);
  expect(execute).not.toHaveBeenCalled();
});
it("dispatch wins deletion: result commits once, then deletion removes source, receipt and job", async () => {
  const own = await queued();
  const entered = latch(),
    release = latch();
  execute.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return registry.adapter("ai", "test").execute(...args);
  });
  const observed = observedDispatch();
  const running = observed.service.run(own.token, own.jobId);
  await entered.promise;
  const deleting = evidence.removeWorkspace(own.token);
  try {
    await waitForDispatchBlock(
      observed.backend.pid,
      "SELECT w.id FROM workspaces%FOR UPDATE OF w",
    );
    expect(
      (
        await pool.query(
          "SELECT deleting_at FROM workspaces WHERE owner_principal_id=$1",
          [own.id],
        )
      ).rows[0].deleting_at,
    ).toBeNull();
  } finally {
    release.resolve();
    await Promise.allSettled([running, deleting]);
  }
  expect(await running).toMatchObject({ kind: "completed" });
  await deleting;
  expect((await pool.query("SELECT id FROM adapter_jobs")).rows).toEqual([]);
  expect(execute).toHaveBeenCalledTimes(1);
});
it("denies live mode even when a registry is forged", async () => {
  const own = await queued();
  const service = localAiConsentStore(pool, objects, {
    ...registry,
    mode: "live",
  } as unknown as AdapterRegistry);
  expect(await service.list(own.token)).toEqual([]);
  expect(await service.grant(own.token, own.evidenceId)).toEqual({
    kind: "denied",
  });
  expect(await service.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
});

it("withdrawal between durable claim and dispatch terminates the claim with zero adapter calls", async () => {
  const own = await queued();
  const entered = latch(),
    release = latch();
  let paused = false;
  const wrapped = {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (sql: string, args?: unknown[]) => {
          const result = await client.query(sql, args);
          if (sql === "COMMIT" && !paused) {
            paused = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        },
        release: (broken?: boolean) => client.release(broken),
      };
    },
  } as unknown as typeof pool;
  const service = localAiConsentStore(wrapped, objects, {
    mode: "test",
    adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
  });
  const running = service.run(own.token, own.jobId);
  await entered.promise;
  expect(
    (
      await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [
        own.jobId,
      ])
    ).rows[0].status,
  ).toBe("running");
  expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
  release.resolve();
  expect(await running).toEqual({ kind: "denied" });
  expect(
    (
      await pool.query(
        "SELECT status,attempt_token FROM adapter_jobs WHERE id=$1",
        [own.jobId],
      )
    ).rows[0],
  ).toEqual({ status: "exhausted", attempt_token: null });
  expect(execute).not.toHaveBeenCalled();
});
it("expiry while waiting for exact-source bytes prevents adapter access", async () => {
  const own = await queued();
  const entered = latch(),
    release = latch();
  const service = localAiConsentStore(
    pool,
    {
      ...objects,
      get: async (key) => {
        entered.resolve();
        await release.promise;
        return objects.get(key);
      },
    },
    {
      mode: "test",
      adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
    },
  );
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",
    [own.id],
  );
  const running = service.run(own.token, own.jobId);
  await entered.promise;
  await pool.query("SELECT pg_sleep(0.17)");
  release.resolve();
  expect(await running).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
  expect(
    (
      await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [
        own.jobId,
      ])
    ).rows[0].status,
  ).toBe("failed");
});
it("a concurrent new revision wins the source lock and retires its old permission", async () => {
  const own = await queued();
  await evidence.submitForReview(own.token, own.evidenceId);
  const c = await pool.connect();
  await c.query("BEGIN");
  await c.query("SELECT id FROM evidence_objects WHERE id=$1 FOR UPDATE", [
    own.evidenceId,
  ]);
  const row = (
    await c.query("SELECT workspace_id FROM evidence_objects WHERE id=$1", [
      own.evidenceId,
    ])
  ).rows[0];
  await c.query(
    "INSERT INTO evidence_objects(id,workspace_id,owner_principal_id,original_name,media_type,byte_size,sha256,storage_key,quarantine_state,private_review_allowed,community_publication_allowed,rights_attested_at,revision_parent_id,revision_number) VALUES($1,$2,$3,'Revision.txt','text/plain',1,$4,$5,'pending',true,false,clock_timestamp(),$6,2)",
    [
      randomUUID(),
      row.workspace_id,
      own.id,
      "a".repeat(64),
      randomUUID(),
      own.evidenceId,
    ],
  );
  const running = local.run(own.token, own.jobId);
  await c.query("COMMIT");
  c.release();
  expect(await running).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
});
it("invalid adapter output stores only safe failure state and bounded retries", async () => {
  const own = await queued();
  execute.mockResolvedValue({ private: "arbitrary text" } as never);
  for (let n = 0; n < 3; n++)
    expect(await local.run(own.token, own.jobId)).toMatchObject({
      kind: "unavailable",
      status: "failed",
    });
  expect(await local.run(own.token, own.jobId)).toMatchObject({
    status: "exhausted",
  });
  expect(execute).toHaveBeenCalledTimes(3);
  expect(
    (
      await pool.query(
        "SELECT provider_operation_reference,safe_error FROM adapter_jobs WHERE id=$1",
        [own.jobId],
      )
    ).rows[0],
  ).toEqual({
    provider_operation_reference: null,
    safe_error: "invalid_provider_response",
  });
});

it("withdraws retired source permission and cannot resurrect it by deleting the newer revision", async () => {
  const own = await queued();
  await evidence.submitForReview(own.token, own.evidenceId);
  const next = await fixture(
    own,
    own.evidenceId,
    "Invented revision for revocation",
  );
  expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
  await evidence.remove(own.token, next.evidenceId);
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(await local.enqueue(own.token, own.receiptId, "resurrection")).toEqual(
    { kind: "denied" },
  );
  expect(
    (
      await pool.query(
        "SELECT withdrawn_at FROM local_ai_receipts WHERE id=$1",
        [own.receiptId],
      )
    ).rows[0].withdrawn_at,
  ).toBeInstanceOf(Date);
  expect(
    (
      await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [
        own.jobId,
      ])
    ).rows[0].status,
  ).toBe("exhausted");
  expect(execute).not.toHaveBeenCalled();
});

it("creating then deleting a newer revision never revives an earlier active AI grant", async () => {
  const own = await queued();
  await evidence.submitForReview(own.token, own.evidenceId);
  const next = await fixture(
    own,
    own.evidenceId,
    "Invented temporary revision",
  );
  await evidence.remove(own.token, next.evidenceId);
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(await local.enqueue(own.token, own.receiptId, "old-receipt")).toEqual({
    kind: "denied",
  });
  expect(execute).not.toHaveBeenCalled();
});

it("never delivers private bytes to a forged live adapter returned by a test registry", async () => {
  const own = await queued();
  const service = localAiConsentStore(pool, objects, {
    mode: "test",
    adapter: () => ({ kind: "ai", mode: "live", execute }),
  });
  await service.run(own.token, own.jobId);
  expect(execute).not.toHaveBeenCalled();
});

it("permits only the current owner to withdraw a quarantined or deleting source receipt", async () => {
  for (const state of ["pending", "rejected", "infected", "deleting"]) {
    const own = await queued();
    const other = await member();
    await pool.query(
      "UPDATE evidence_objects SET quarantine_state=$2 WHERE id=$1",
      [own.evidenceId, state],
    );
    expect(await local.withdraw(other.token, own.receiptId)).toBe(false);
    expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
    expect(
      (
        await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [
          own.jobId,
        ])
      ).rows[0].status,
    ).toBe("exhausted");
  }
  expect(execute).not.toHaveBeenCalled();
});
it("dispatch that wins revision creation commits once, then the revision permanently retires its permission", async () => {
  const own = await queued();
  await evidence.submitForReview(own.token, own.evidenceId);
  const entered = latch(),
    release = latch();
  execute.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return registry.adapter("ai", "test").execute(...args);
  });
  const running = local.run(own.token, own.jobId);
  await entered.promise;
  const revising = fixture(own, own.evidenceId, "Invented newer version");
  release.resolve();
  expect(await running).toMatchObject({ kind: "completed" });
  const next = await revising;
  expect(
    (
      await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [
        own.jobId,
      ])
    ).rows[0].status,
  ).toBe("succeeded");
  await evidence.remove(own.token, next.evidenceId);
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("persisted pause rejects new queue requests and stale pending dispatch without invoking the adapter", async () => {
  const own = await queued();
  await pool.query(
    "UPDATE local_ai_control SET paused=true WHERE singleton=true",
  );
  try {
    expect(await local.enqueue(own.token, own.receiptId, randomUUID())).toEqual(
      { kind: "denied" },
    );
    expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
    expect(execute).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "SELECT status,attempt_count FROM adapter_jobs WHERE id=$1",
          [own.jobId],
        )
      ).rows[0],
    ).toEqual({ status: "pending", attempt_count: 0 });
  } finally {
    await pool.query(
      "UPDATE local_ai_control SET paused=false WHERE singleton=true",
    );
  }
});

import { localAiControlStore } from "../../src/local-ai-control.ts";
import { authorizationStore, type StaffRole } from "../../src/authorization.ts";
const control = localAiControlStore(pool);
afterEach(async () => {
  await pool.query(
    "UPDATE local_ai_control SET paused=false WHERE singleton=true",
  );
});
async function staff(role: StaffRole = "platform_admin") {
  const token = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    token,
    role,
    new Date(Date.now() + 60_000),
  );
  return { token, id };
}
beforeEach(async () => {
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
});
it("only active platform admins can read or change persistent idempotent pause state", async () => {
  const admin = await staff();
  expect(await control.current()).toBe("enabled");
  expect(await control.read(admin.token)).toEqual({ paused: false });
  for (const identity of [
    await member(),
    await staff("reviewer"),
    await staff("operator"),
    { token: "unknown" },
  ]) {
    expect(await control.read(identity.token)).toBeNull();
    expect(await control.set(identity.token, true)).toBe(false);
  }
  expect(await control.set(admin.token, true)).toBe(true);
  expect(await control.set(admin.token, true)).toBe(true);
  await migrate(pool);
  expect(
    (await pool.query("SELECT version FROM schema_migrations WHERE version=40"))
      .rows,
  ).toEqual([{ version: 40 }]);
  expect(await localAiControlStore(pool).read(admin.token)).toEqual({
    paused: true,
  });
  expect(await control.current()).toBe("paused");
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
    [admin.id],
  );
  expect(await control.set(admin.token, false)).toBe(false);
  const expired = await staff();
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
    [expired.id],
  );
  expect(await control.set(expired.token, false)).toBe(false);
});
it("missing control row denies dispatch, queue and admin changes without touching permission or another job", async () => {
  const own = await queued();
  const other = await queued();
  const admin = await staff();
  await pool.query("DELETE FROM local_ai_control");
  await migrate(pool);
  expect(await control.current()).toBe("unavailable");
  expect(await control.read(admin.token)).toBeNull();
  expect(await control.set(admin.token, false)).toBe(false);
  expect(await local.enqueue(own.token, own.receiptId, randomUUID())).toEqual({
    kind: "denied",
  });
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
  expect(
    (
      await pool.query(
        "SELECT status,attempt_count FROM adapter_jobs WHERE id=$1",
        [other.jobId],
      )
    ).rows[0],
  ).toEqual({ status: "pending", attempt_count: 0 });
  expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
});
it("pause wins the control row before pending dispatch, which makes zero adapter calls", async () => {
  const own = await queued();
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await blocker.query(
      "UPDATE local_ai_control SET paused=true WHERE singleton=true",
    );
    const running = local.run(own.token, own.jobId);
    await waitForDispatchBlock(
      pid,
      "SELECT paused FROM local_ai_control%FOR SHARE",
    );
    expect(execute).not.toHaveBeenCalled();
    await blocker.query("COMMIT");
    expect(await running).toEqual({ kind: "denied" });
    expect(
      (
        await pool.query(
          "SELECT status,attempt_count FROM adapter_jobs WHERE id=$1",
          [own.jobId],
        )
      ).rows[0],
    ).toEqual({ status: "pending", attempt_count: 0 });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});
it("dispatch wins: admin pause blocks until the bounded invocation commits success", async () => {
  const own = await queued();
  const admin = await staff();
  const entered = latch();
  const finish = latch();
  execute.mockImplementation(async (...args) => {
    entered.resolve();
    await finish.promise;
    return registry.adapter("ai", "test").execute(...args);
  });
  const observed = observedDispatch();
  const running = observed.service.run(own.token, own.jobId);
  await entered.promise;
  const pausing = control.set(admin.token, true);
  try {
    await waitForDispatchBlock(
      observed.backend.pid,
      "SELECT paused FROM local_ai_control%FOR UPDATE",
    );
    expect(await control.current()).toBe("enabled");
  } finally {
    finish.resolve();
  }
  expect(await running).toMatchObject({
    kind: "completed",
    status: "succeeded",
  });
  expect(await pausing).toBe(true);
  expect(await control.current()).toBe("paused");
  expect(execute).toHaveBeenCalledTimes(1);
});
it("pause between durable claim and execution holds the attempt through resume without retry", async () => {
  const own = await queued();
  const admin = await staff();
  let connections = 0;
  const interrupted = localAiConsentStore(
    {
      async connect() {
        if (++connections === 2)
          expect(await control.set(admin.token, true)).toBe(true);
        return pool.connect();
      },
    } as unknown as typeof pool,
    objects,
    {
      mode: "test",
      adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
    },
  );
  expect(await interrupted.run(own.token, own.jobId)).toEqual({
    kind: "unavailable",
  });
  expect(
    (
      await pool.query(
        "SELECT status,attempt_count FROM adapter_jobs WHERE id=$1",
        [own.jobId],
      )
    ).rows[0],
  ).toEqual({ status: "running", attempt_count: 1 });
  expect(await control.set(admin.token, false)).toBe(true);
  expect(await local.run(own.token, own.jobId)).toMatchObject({
    kind: "unavailable",
    status: "running",
  });
  expect(execute).not.toHaveBeenCalled();
  await pool.query(
    "UPDATE adapter_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [own.jobId],
  );
  expect(await local.run(own.token, own.jobId)).toMatchObject({
    kind: "unavailable",
    status: "needs_reconciliation",
  });
  expect(execute).not.toHaveBeenCalled();
});
it("resume preserves withdrawals and pending work waits for a fresh explicit dispatch", async () => {
  const own = await queued();
  const other = await queued();
  const admin = await staff();
  expect(await control.set(admin.token, true)).toBe(true);
  expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
  expect(await control.set(admin.token, false)).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
  expect(await local.run(other.token, other.jobId)).toMatchObject({
    kind: "completed",
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("queue waits behind a committed pause and creates no additional job", async () => {
  const own = await granted();
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await blocker.query(
      "UPDATE local_ai_control SET paused=true WHERE singleton=true",
    );
    const enqueuing = local.enqueue(own.token, own.receiptId, randomUUID());
    await waitForDispatchBlock(
      pid,
      "SELECT paused FROM local_ai_control%FOR SHARE",
    );
    await blocker.query("COMMIT");
    expect(await enqueuing).toEqual({ kind: "denied" });
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM adapter_jobs")).rows[0]
        .n,
    ).toBe(0);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

it("admin role revocation wins a profile lock wait and prevents the pause change", async () => {
  const admin = await staff();
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await blocker.query(
      "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
      [admin.id],
    );
    const pausing = control.set(admin.token, true);
    await waitForDispatchBlock(pid, "SELECT p.id%FOR SHARE OF p,s");
    await blocker.query("COMMIT");
    expect(await pausing).toBe(false);
    expect(await control.current()).toBe("enabled");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

it("admin expiry after a profile lock wait is rechecked before mutation", async () => {
  const admin = await staff();
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
    [admin.id],
  );
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    const pid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await blocker.query(
      "SELECT 1 FROM staff_profiles WHERE principal_id=$1 FOR UPDATE",
      [admin.id],
    );
    const pausing = control.set(admin.token, true);
    await waitForDispatchBlock(pid, "SELECT p.id%FOR SHARE OF p,s");
    for (;;) {
      const expired = (
        await pool.query(
          "SELECT expires_at<=clock_timestamp() AS expired FROM principals WHERE id=$1",
          [admin.id],
        )
      ).rows[0].expired;
      if (expired) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await blocker.query("COMMIT");
    expect(await pausing).toBe(false);
    expect(await control.current()).toBe("enabled");
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
});

for (const target of ["principal", "profile"] as const) {
  it(`admin change holds its ${target} authorization lock through commit`, async () => {
    const admin = await staff();
    const entered = latch();
    const finish = latch();
    let pid = 0;
    const service = localAiControlStore({
      async connect() {
        const client = await pool.connect();
        pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid as number;
        return {
          release: client.release.bind(client),
          async query(sql: string, args?: unknown[]) {
            if (sql.startsWith("UPDATE local_ai_control")) {
              entered.resolve();
              await finish.promise;
            }
            return client.query(sql, args);
          },
        };
      },
    } as unknown as typeof pool);
    const pausing = service.set(admin.token, true);
    await entered.promise;
    const sql =
      target === "principal"
        ? "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1"
        : "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1";
    const revoking = pool.query(sql, [admin.id]);
    try {
      await waitForDispatchBlock(pid, sql.replace("$1", "%"));
    } finally {
      finish.resolve();
    }
    expect(await pausing).toBe(true);
    await revoking;
    expect(await control.current()).toBe("paused");
    expect(await control.set(admin.token, false)).toBe(false);
  });
}

it("database constraints reject malformed and duplicate switch state", async () => {
  await expect(
    pool.query("UPDATE local_ai_control SET paused=NULL"),
  ).rejects.toMatchObject({ code: "23502" });
  await expect(
    pool.query("INSERT INTO local_ai_control VALUES(false,false)"),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    pool.query("INSERT INTO local_ai_control VALUES(true,true)"),
  ).rejects.toMatchObject({ code: "23505" });
  expect(await control.current()).toBe("enabled");
});
