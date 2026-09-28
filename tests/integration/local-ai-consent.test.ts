import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
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
function observedDispatch() {
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
    service: localAiConsentStore(observedPool, objects, {
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
