import type { PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { syntheticLedger } from "../../src/ledger.ts";

const pool = testPool();
const db = store(pool);
const ledger = syntheticLedger(pool);
const data = new Map<string, Buffer>();
const objects: ObjectStorage = {
  put: async (key, value) => {
    data.set(key, value);
  },
  get: async (key) => {
    const value = data.get(key);
    if (!value) throw Error("Synthetic source absent");
    return value;
  },
  remove: async (key) => {
    data.delete(key);
  },
};
const registry = deterministicRegistry({}, "test");
const execute = vi.fn(registry.adapter("ai", "test").execute);
const local = localAiConsentStore(pool, objects, {
  mode: "test",
  adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
});
const evidence = evidenceStore(pool, objects, "synthetic-metered-local-secret");
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  data.clear();
  execute.mockReset();
  execute.mockImplementation(registry.adapter("ai", "test").execute);
});
afterAll(() => pool.end());
async function fixture(person?: { token: string; id: string }) {
  let owner = person;
  if (!owner) {
    const token = randomBytes(32).toString("hex");
    await db.create(token, { background: "explorer", goal: "everyday" });
    const session = await db.session(token);
    if (session.kind !== "active") throw Error("Synthetic member unavailable");
    owner = { token, id: session.learner.id };
  }
  const uploaded = await evidence.upload(owner.token, {
    name: "Invented-budget.txt",
    mediaType: "text/plain",
    data: Buffer.from("Invented source for private local practice"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw Error("Synthetic upload unavailable");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  const permission = await local.grant(owner.token, uploaded.id);
  if (permission.kind !== "granted")
    throw Error("Synthetic permission unavailable");
  return { ...owner, evidenceId: uploaded.id, receiptId: permission.receiptId };
}
async function grant(owner: { id: string }, quantity = 1) {
  return ledger.grant(owner.id, "study_requests", quantity, randomUUID(), {
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}
async function balance(grantId: string) {
  return (
    await pool.query(
      "SELECT available,reserved,consumed,expired FROM synthetic_entitlement_grants WHERE id=$1",
      [grantId],
    )
  ).rows[0];
}
it("holds one seeded request before dispatch, consumes once and replays the owned result", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const key = randomUUID();
  const queued = await local.enqueueMetered(owner.token, owner.receiptId, key);
  expect(queued.kind).toBe("queued");
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(execute).not.toHaveBeenCalled();
  expect(await local.enqueueMetered(owner.token, owner.receiptId, key)).toEqual(
    queued,
  );
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("completed");
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("completed");
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 0,
    consumed: 1,
    expired: 0,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  const events = (
    await pool.query(
      "SELECT operation,count(*)::int AS count FROM synthetic_entitlement_events WHERE grant_id=$1 GROUP BY operation ORDER BY operation",
      [grantId],
    )
  ).rows;
  expect(events).toEqual([
    { operation: "consume", count: 1 },
    { operation: "grant", count: 1 },
    { operation: "reserve", count: 1 },
  ]);
});
it("last seeded unit has one winner across different source receipts and no loser job", async () => {
  const one = await fixture();
  const two = await fixture(one);
  const grantId = await grant(one);
  const results = await Promise.all([
    local.enqueueMetered(one.token, one.receiptId, randomUUID()),
    local.enqueueMetered(two.token, two.receiptId, randomUUID()),
  ]);
  expect(results.filter((r) => r.kind === "queued")).toHaveLength(1);
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM adapter_jobs WHERE member_id=$1",
        [one.id],
      )
    ).rows[0].count,
  ).toBe(1);
  expect(execute).not.toHaveBeenCalled();
});
it("no grant or paused control creates no metered job and invokes nothing", async () => {
  const owner = await fixture();
  expect(
    (await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()))
      .kind,
  ).not.toBe("queued");
  const grantId = await grant(owner);
  await pool.query("UPDATE local_ai_control SET paused=true");
  expect(
    (await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()))
      .kind,
  ).not.toBe("queued");
  expect(await balance(grantId)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
  expect(
    (await pool.query("SELECT count(*)::int AS count FROM adapter_jobs"))
      .rows[0].count,
  ).toBe(0);
  expect(execute).not.toHaveBeenCalled();
});
it("permission withdrawal before claim restores exactly once and prevents dispatch", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  expect(await local.withdraw(owner.token, owner.receiptId)).toBe(true);
  expect(await local.withdraw(owner.token, owner.receiptId)).toBe(true);
  expect((await local.run(owner.token, queued.jobId)).kind).not.toBe(
    "completed",
  );
  expect(await balance(grantId)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
  expect(execute).not.toHaveBeenCalled();
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation='release'",
        [grantId],
      )
    ).rows[0].count,
  ).toBe(1);
});
it("ambiguous dispatch stays held through repeated run and permission withdrawal", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  execute.mockRejectedValue(new Error("Invented secret provider failure"));
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("unavailable");
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("unavailable");
  expect(await local.withdraw(owner.token, owner.receiptId)).toBe(true);
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(execute).toHaveBeenCalledTimes(1);
  const retained = JSON.stringify(
    (await pool.query("SELECT * FROM adapter_jobs WHERE id=$1", [queued.jobId]))
      .rows,
  );
  expect(retained).not.toContain("Invented secret provider failure");
});
it("ordinary ledger settlement cannot release a linked member AI reservation", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  const reservation = (
    await pool.query(
      "SELECT id FROM synthetic_entitlement_reservations WHERE grant_id=$1",
      [grantId],
    )
  ).rows[0];
  await expect(
    ledger.release(owner.id, reservation.id, randomUUID()),
  ).rejects.toThrow();
  await expect(
    ledger.consume(owner.id, reservation.id, randomUUID()),
  ).rejects.toThrow();
  await expect(
    ledger.settleCompletion(owner.id, reservation.id, randomUUID(), {
      reference: "synthetic:local-bypass",
      category: "study_requests",
      quantity: 1,
    }),
  ).rejects.toThrow();
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
});

it("late permission withdrawal expires the never-claimed unit instead of making it usable", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  expect(queued.kind).toBe("queued");
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [grantId],
  );
  expect(await local.withdraw(owner.token, owner.receiptId)).toBe(true);
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 0,
    consumed: 0,
    expired: 1,
  });
  expect(execute).not.toHaveBeenCalled();
});
it("removing a never-claimed source releases its unit and retains only safe accounting linkage", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  expect(await evidence.remove(owner.token, owner.evidenceId)).toBe(true);
  expect(await balance(grantId)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
  const job = (
    await pool.query(
      "SELECT status,local_ai_receipt_id FROM adapter_jobs WHERE id=$1",
      [queued.jobId],
    )
  ).rows[0];
  expect(job).toEqual({ status: "exhausted", local_ai_receipt_id: null });
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("denied");
  expect(data.size).toBe(0);
  expect(execute).not.toHaveBeenCalled();
});
it("removing an uncertain dispatched source keeps its one held unit and never replays", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  execute.mockRejectedValue(new Error("Invented ambiguous provider outcome"));
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("unavailable");
  expect(await evidence.remove(owner.token, owner.evidenceId)).toBe(true);
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT status,local_ai_receipt_id FROM adapter_jobs WHERE id=$1",
        [queued.jobId],
      )
    ).rows[0],
  ).toEqual({ status: "needs_reconciliation", local_ai_receipt_id: null });
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("denied");
  expect(data.size).toBe(0);
  expect(execute).toHaveBeenCalledTimes(1);
});
it("invalid dispatched results stay held and cannot inherit the unmetered failed-job retry", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  execute.mockResolvedValue({ kind: "invalid" } as never);
  expect(await local.run(owner.token, queued.jobId)).toEqual({
    kind: "unavailable",
    jobId: queued.jobId,
    status: "needs_reconciliation",
  });
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("unavailable");
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(execute).toHaveBeenCalledTimes(1);
});
it("the same key cannot change from metered to unmetered", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const key = randomUUID();
  const metered = await local.enqueueMetered(owner.token, owner.receiptId, key);
  expect(metered.kind).toBe("queued");
  expect(await local.enqueue(owner.token, owner.receiptId, key)).toEqual({
    kind: "conflict",
  });
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(execute).not.toHaveBeenCalled();
});
it("the same key cannot change from unmetered to metered or spend a unit", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const key = randomUUID();
  expect((await local.enqueue(owner.token, owner.receiptId, key)).kind).toBe(
    "queued",
  );
  expect(await local.enqueueMetered(owner.token, owner.receiptId, key)).toEqual(
    { kind: "conflict" },
  );
  expect(await balance(grantId)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
  expect(execute).not.toHaveBeenCalled();
});
it("member erasure removes its metered linkage and preserves another member's balance", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const other = await fixture();
  const otherGrant = await grant(other, 2);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  expect(queued.kind).toBe("queued");
  await db.remove(owner.id);
  expect(await balance(grantId)).toBeUndefined();
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_test_unit_jobs WHERE member_id=$1",
        [owner.id],
      )
    ).rows[0].count,
  ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM synthetic_entitlement_events WHERE member_id=$1",
        [owner.id],
      )
    ).rows[0].count,
  ).toBe(0);
  expect(await balance(otherGrant)).toEqual({
    available: 2,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
});
it("the private receipt lists the safe test-unit state without exposing reservation IDs", async () => {
  const owner = await fixture();
  await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  expect((await local.list(owner.token))[0]!.jobs).toEqual([
    { id: queued.jobId, status: "pending", testUnitState: "reserved" },
  ]);
  await local.run(owner.token, queued.jobId);
  expect((await local.list(owner.token))[0]!.jobs).toEqual([
    { id: queued.jobId, status: "succeeded", testUnitState: "consumed" },
  ]);
});

function faultService(
  options: {
    after?: (sql: string, commits: number, client: PoolClient) => Promise<void>;
    releaseFailure?: boolean;
  } = {},
) {
  let commits = 0;
  const state = { pid: 0 };
  const service = localAiConsentStore(
    {
      connect: async () => {
        const client = await pool.connect();
        state.pid = (
          await client.query("SELECT pg_backend_pid() AS pid")
        ).rows[0].pid;
        return {
          query: async (sql: string, params?: unknown[]) => {
            const result = await client.query(sql, params);
            if (sql === "COMMIT") commits++;
            await options.after?.(sql, commits, client);
            return result;
          },
          on: client.on.bind(client),
          removeListener: client.removeListener.bind(client),
          release: (error?: Error | boolean) => {
            client.release(error);
            if (options.releaseFailure)
              throw Error("Invented pool handback failure");
          },
        };
      },
    } as unknown as typeof pool,
    objects,
    {
      mode: "test",
      adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
    },
  );
  return { service, state };
}
it("an uncertain queue commit can be inspected and replayed without a second reservation", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const key = randomUUID();
  const fault = faultService({
    after: async (sql, commits) => {
      if (sql === "COMMIT" && commits === 1)
        throw Error("Invented lost commit acknowledgement");
    },
  });
  expect(
    await fault.service.enqueueMetered(owner.token, owner.receiptId, key),
  ).toEqual({ kind: "denied" });
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (await fault.service.enqueueMetered(owner.token, owner.receiptId, key))
      .kind,
  ).toBe("queued");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation='reserve'",
        [grantId],
      )
    ).rows[0].count,
  ).toBe(1);
  expect(execute).not.toHaveBeenCalled();
});
it("an uncertain successful settlement is consumed once and never dispatched again", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const fault = faultService({
    after: async (sql, commits) => {
      if (sql === "COMMIT" && commits === 3)
        throw Error("Invented settlement acknowledgement loss");
    },
  });
  const queued = await fault.service.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  expect((await fault.service.run(owner.token, queued.jobId)).kind).toBe(
    "unavailable",
  );
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 0,
    consumed: 1,
    expired: 0,
  });
  expect((await fault.service.run(owner.token, queued.jobId)).kind).toBe(
    "completed",
  );
  expect(execute).toHaveBeenCalledTimes(1);
});
it("pool handback failure withholds queue success without leaking an exception or duplicating its hold", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const fault = faultService({ releaseFailure: true });
  await expect(
    fault.service.enqueueMetered(owner.token, owner.receiptId, randomUUID()),
  ).resolves.toEqual({ kind: "denied" });
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(execute).not.toHaveBeenCalled();
});
it("real dispatch connection termination is contained and retains the unresolved one-unit hold", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const fault = faultService();
  const queued = await fault.service.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  execute.mockImplementation(async (...args) => {
    expect(
      (
        await pool.query("SELECT pg_terminate_backend($1) AS stopped", [
          fault.state.pid,
        ])
      ).rows[0].stopped,
    ).toBe(true);
    return registry.adapter("ai", "test").execute(...args);
  });
  expect((await fault.service.run(owner.token, queued.jobId)).kind).toBe(
    "unavailable",
  );
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT status,attempt_count FROM adapter_jobs WHERE id=$1",
        [queued.jobId],
      )
    ).rows[0],
  ).toEqual({ status: "running", attempt_count: 1 });
  expect((await fault.service.run(owner.token, queued.jobId)).kind).toBe(
    "unavailable",
  );
  expect(execute).toHaveBeenCalledTimes(1);
});
it("a metered job cannot claim success before its held reservation is consumed", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  await expect(
    pool.query(
      "UPDATE adapter_jobs SET status='succeeded',provider_operation_reference='local_invented' WHERE id=$1",
      [queued.jobId],
    ),
  ).rejects.toThrow();
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (
      await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [
        queued.jobId,
      ])
    ).rows[0].status,
  ).toBe("pending");
});
it("final session expiry after the settlement lock rolls back consumption and keeps the claimed hold", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const fault = faultService({
    after: async (sql, commits, client) => {
      if (commits === 2 && sql.includes("pg_advisory_xact_lock")) {
        // Deterministically advance the locked principal's deadline at the exact
        // settlement boundary; no sleep, retry or parallel revocation bypass.
        await client.query(
          "UPDATE principals SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
          [owner.id],
        );
      }
    },
  });
  const queued = await fault.service.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  expect((await fault.service.run(owner.token, queued.jobId)).kind).toBe(
    "unavailable",
  );
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT status,attempt_count FROM adapter_jobs WHERE id=$1",
        [queued.jobId],
      )
    ).rows[0],
  ).toEqual({ status: "running", attempt_count: 1 });
  expect(execute).toHaveBeenCalledTimes(1);
});
it("final lease expiry after the settlement lock cannot commit a late successful result", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  let jobId = "";
  const fault = faultService({
    after: async (sql, commits, client) => {
      if (commits === 2 && sql.includes("pg_advisory_xact_lock"))
        await client.query(
          "UPDATE adapter_jobs SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
          [jobId],
        );
    },
  });
  const queued = await fault.service.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  jobId = queued.jobId;
  expect((await fault.service.run(owner.token, jobId)).kind).toBe(
    "unavailable",
  );
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [jobId]))
      .rows[0].status,
  ).toBe("running");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("repeated migration preserves legacy unmetered jobs and all metered accounting states", async () => {
  const owner = await fixture();
  const legacy = await local.enqueue(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  expect(legacy.kind).toBe("queued");
  for (const state of ["pending", "consumed", "uncertain"] as const) {
    const source = await fixture(owner);
    await grant(owner);
    const queued = await local.enqueueMetered(
      owner.token,
      source.receiptId,
      randomUUID(),
    );
    if (queued.kind !== "queued") throw Error("Expected metered queue");
    if (state === "uncertain")
      execute.mockRejectedValueOnce(Error("Invented uncertain outcome"));
    if (state !== "pending") await local.run(owner.token, queued.jobId);
  }
  async function snapshot() {
    const tables = [
      "adapter_jobs",
      "local_ai_test_unit_jobs",
      "synthetic_entitlement_grants",
      "synthetic_entitlement_reservations",
      "synthetic_entitlement_events",
    ];
    return Promise.all(
      tables.map(
        async (table) =>
          (
            await pool.query(
              `SELECT to_jsonb(t) AS item FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows,
      ),
    );
  }
  const before = await snapshot();
  await migrate(pool);
  await migrate(pool);
  expect(await snapshot()).toEqual(before);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_test_unit_jobs",
      )
    ).rows[0].count,
  ).toBe(3);
  expect(execute).toHaveBeenCalledTimes(2);
});
it("accounting links cannot be edited or detached while the member exists", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  await expect(
    pool.query(
      "UPDATE local_ai_test_unit_jobs SET policy=policy WHERE job_id=$1",
      [queued.jobId],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query("DELETE FROM local_ai_test_unit_jobs WHERE job_id=$1", [
      queued.jobId,
    ]),
  ).rejects.toThrow();
  await expect(
    pool.query("DELETE FROM adapter_jobs WHERE id=$1", [queued.jobId]),
  ).rejects.toThrow();
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM local_ai_test_unit_jobs WHERE job_id=$1",
        [queued.jobId],
      )
    ).rows[0].count,
  ).toBe(1);
});
it("a new source revision releases a never-dispatched request without inheriting permission or spending again", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  await evidence.submitForReview(owner.token, owner.evidenceId);
  const revised = await evidence.upload(owner.token, {
    name: "Invented-revision.txt",
    mediaType: "text/plain",
    data: Buffer.from("Invented revised private source"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
    revisesId: owner.evidenceId,
  });
  expect(revised.kind).toBe("created");
  expect(await balance(grantId)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
  expect(await local.run(owner.token, queued.jobId)).toEqual({
    kind: "denied",
  });
  expect(
    await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()),
  ).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
});
it("selects the earliest-expiring eligible study grant and leaves other categories untouched", async () => {
  const owner = await fixture();
  const later = await grant(owner);
  const window = {
    startsAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  const earlier = await ledger.grant(
    owner.id,
    "study_requests",
    1,
    randomUUID(),
    window,
  );
  const other = await ledger.grant(
    owner.id,
    "review_minutes",
    2,
    randomUUID(),
    window,
  );
  expect(
    (await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()))
      .kind,
  ).toBe("queued");
  expect(await balance(earlier)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(await balance(later)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
  expect(await balance(other)).toEqual({
    available: 2,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
});

it.each([
  "foreign",
  "staff",
  "revoked",
  "expired",
  "deleting",
  "withdrawn",
  "missing-control",
  "wrong-category",
] as const)(
  "metered queue denies %s without an accounting or dispatch write",
  async (boundary) => {
    const owner = await fixture();
    const grantId =
      boundary === "wrong-category"
        ? await ledger.grant(owner.id, "review_minutes", 1, randomUUID(), {
            startsAt: new Date(Date.now() - 60000).toISOString(),
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          })
        : await grant(owner);
    let token = owner.token;
    if (boundary === "foreign") token = (await fixture()).token;
    if (boundary === "staff") {
      token = randomBytes(32).toString("hex");
      await authorizationStore(pool).provisionStaff(
        token,
        "platform_admin",
        new Date(Date.now() + 60000),
      );
    }
    if (boundary === "revoked")
      await pool.query(
        "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
    if (boundary === "expired")
      await pool.query(
        "UPDATE principals SET expires_at=clock_timestamp() WHERE id=$1",
        [owner.id],
      );
    if (boundary === "deleting")
      await pool.query(
        "UPDATE evidence_objects SET quarantine_state='deleting' WHERE id=$1",
        [owner.evidenceId],
      );
    if (boundary === "withdrawn")
      await local.withdraw(owner.token, owner.receiptId);
    if (boundary === "missing-control")
      await pool.query("DELETE FROM local_ai_control");
    expect(
      await local.enqueueMetered(token, owner.receiptId, randomUUID()),
    ).toEqual({ kind: "denied" });
    expect(await balance(grantId)).toEqual({
      available: 1,
      reserved: 0,
      consumed: 0,
      expired: 0,
    });
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM adapter_jobs"))
        .rows[0].count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM synthetic_entitlement_events WHERE operation='reserve'",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  },
);
it.each([
  "wrong-category",
  "wrong-quantity",
  "foreign-grant",
  "wrong-policy",
  "legacy-attempt-limit",
] as const)(
  "link insertion rejects %s without attaching an unrelated reservation",
  async (boundary) => {
    const owner = await fixture();
    const queued = await local.enqueue(
      owner.token,
      owner.receiptId,
      randomUUID(),
    );
    if (queued.kind !== "queued") throw Error("Expected legacy queue");
    if (boundary !== "legacy-attempt-limit")
      await pool.query("UPDATE adapter_jobs SET max_attempts=1 WHERE id=$1", [
        queued.jobId,
      ]);
    const grantOwner = boundary === "foreign-grant" ? await fixture() : owner;
    const grantId = await ledger.grant(
      grantOwner.id,
      boundary === "wrong-category" ? "review_minutes" : "study_requests",
      2,
      randomUUID(),
      {
        startsAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2100-01-01T00:00:00.000Z",
      },
    );
    const reservationId = await ledger.reserve(
      grantOwner.id,
      grantId,
      boundary === "wrong-quantity" ? 2 : 1,
      randomUUID(),
    );
    await expect(
      pool.query(
        "INSERT INTO local_ai_test_unit_jobs(job_id,member_id,reservation_id,policy) VALUES($1,$2,$3,$4)",
        [
          queued.jobId,
          owner.id,
          reservationId,
          boundary === "wrong-policy"
            ? "invented-policy"
            : "deterministic-request-test-v1",
        ],
      ),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM local_ai_test_unit_jobs",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT state FROM synthetic_entitlement_reservations WHERE id=$1",
          [reservationId],
        )
      ).rows[0].state,
    ).toBe("reserved");
    expect(execute).not.toHaveBeenCalled();
  },
);
it.each(["session", "grant"] as const)(
  "the final queue %s deadline rolls back its job, reserve event and hold",
  async (boundary) => {
    const owner = await fixture();
    const grantId = await grant(owner);
    const fault = faultService({
      after: async (sql, _commits, client) => {
        if (sql.includes("INSERT INTO local_ai_test_unit_jobs"))
          await client.query(
            boundary === "session"
              ? "UPDATE principals SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1"
              : "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
            [boundary === "session" ? owner.id : grantId],
          );
      },
    });
    expect(
      await fault.service.enqueueMetered(
        owner.token,
        owner.receiptId,
        randomUUID(),
      ),
    ).toEqual({ kind: "denied" });
    expect(await balance(grantId)).toEqual({
      available: 1,
      reserved: 0,
      consumed: 0,
      expired: 0,
    });
    expect(
      (await pool.query("SELECT count(*)::int AS count FROM adapter_jobs"))
        .rows[0].count,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM synthetic_entitlement_events WHERE operation='reserve'",
        )
      ).rows[0].count,
    ).toBe(0);
  },
);
it("pausing the current application preserves pending and uncertain history without dispatch or refund", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  await pool.query("UPDATE local_ai_control SET paused=true");
  expect(await local.run(owner.token, queued.jobId)).toEqual({
    kind: "denied",
  });
  expect(
    await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()),
  ).toEqual({ kind: "denied" });
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(execute).not.toHaveBeenCalled();
  await pool.query("UPDATE local_ai_control SET paused=false");
  execute.mockRejectedValue(Error("Invented uncertain local boundary"));
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("unavailable");
  await pool.query("UPDATE local_ai_control SET paused=true");
  await pool.query("UPDATE local_ai_control SET paused=false");
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("unavailable");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
});
it("an already expired grant cannot dispatch its pending metered request", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [grantId],
  );
  expect((await local.run(owner.token, queued.jobId)).kind).not.toBe(
    "completed",
  );
  expect(execute).not.toHaveBeenCalled();
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
});
it("a grant deadline crossed during settlement cannot commit a result or consumption", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const fault = faultService({
    after: async (sql, commits, client) => {
      if (commits === 2 && sql.includes("pg_advisory_xact_lock"))
        await client.query(
          "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
          [grantId],
        );
    },
  });
  const queued = await fault.service.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  expect((await fault.service.run(owner.token, queued.jobId)).kind).toBe(
    "unavailable",
  );
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  expect(execute).toHaveBeenCalledTimes(1);
});
it.each(["pause", "withdrawal", "source-removal", "revocation"] as const)(
  "%s winning after the durable claim leaves one hold and no dispatch or refund",
  async (boundary) => {
    const owner = await fixture();
    const grantId = await grant(owner);
    const fault = faultService({
      after: async (sql, commits) => {
        if (sql !== "COMMIT" || commits !== 2) return;
        if (boundary === "pause")
          await pool.query("UPDATE local_ai_control SET paused=true");
        if (boundary === "withdrawal")
          await local.withdraw(owner.token, owner.receiptId);
        if (boundary === "source-removal")
          await evidence.remove(owner.token, owner.evidenceId);
        if (boundary === "revocation")
          await pool.query(
            "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
            [owner.id],
          );
      },
    });
    const queued = await fault.service.enqueueMetered(
      owner.token,
      owner.receiptId,
      randomUUID(),
    );
    if (queued.kind !== "queued") throw Error("Expected metered queue");
    expect((await fault.service.run(owner.token, queued.jobId)).kind).not.toBe(
      "completed",
    );
    if (boundary === "pause")
      await pool.query("UPDATE local_ai_control SET paused=false");
    expect((await local.run(owner.token, queued.jobId)).kind).not.toBe(
      "completed",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await balance(grantId)).toEqual({
      available: 0,
      reserved: 1,
      consumed: 0,
      expired: 0,
    });
    expect(
      (
        await pool.query("SELECT attempt_count FROM adapter_jobs WHERE id=$1", [
          queued.jobId,
        ])
      ).rows[0].attempt_count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation='release'",
          [grantId],
        )
      ).rows[0].count,
    ).toBe(0);
  },
);
it("same-key concurrent requests share one job and replay after grant expiry without another hold", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const key = randomUUID();
  const results = await Promise.all([
    local.enqueueMetered(owner.token, owner.receiptId, key),
    local.enqueueMetered(owner.token, owner.receiptId, key),
  ]);
  expect(results[0].kind).toBe("queued");
  expect(results[1]).toEqual(results[0]);
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [grantId],
  );
  expect(await local.enqueueMetered(owner.token, owner.receiptId, key)).toEqual(
    results[0],
  );
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM adapter_jobs WHERE member_id=$1",
        [owner.id],
      )
    ).rows[0].count,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM synthetic_entitlement_events WHERE grant_id=$1 AND operation='reserve'",
        [grantId],
      )
    ).rows[0].count,
  ).toBe(1);
  expect(execute).not.toHaveBeenCalled();
});
it.each([
  "coach_minutes",
  "review_minutes",
  "support_minutes",
  "mock_sessions",
] as const)("%s is never substituted for a study request", async (category) => {
  const owner = await fixture();
  const grantId = await ledger.grant(owner.id, category, 1, randomUUID(), {
    startsAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2100-01-01T00:00:00.000Z",
  });
  expect(
    await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()),
  ).toEqual({ kind: "denied" });
  expect(await balance(grantId)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
  expect(execute).not.toHaveBeenCalled();
});
it.each(["future", "expired", "spent"] as const)(
  "a %s study grant cannot create a new job or reservation",
  async (boundary) => {
    const owner = await fixture();
    const grantId = await grant(owner);
    if (boundary === "future")
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET starts_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
        [grantId],
      );
    if (boundary === "expired")
      await pool.query(
        "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [grantId],
      );
    if (boundary === "spent")
      await ledger.consume(
        owner.id,
        await ledger.reserve(owner.id, grantId, 1, randomUUID()),
        randomUUID(),
      );
    expect(
      await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()),
    ).toEqual({ kind: "denied" });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM adapter_jobs WHERE member_id=$1",
          [owner.id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  },
);
it("equal grant deadlines use stable grant IDs and capture that selection on the reservation", async () => {
  const owner = await fixture();
  const window = {
    startsAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2100-01-01T00:00:00.000Z",
  };
  const ids = [
    await ledger.grant(owner.id, "study_requests", 1, randomUUID(), window),
    await ledger.grant(owner.id, "study_requests", 1, randomUUID(), window),
  ].sort();
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  expect(
    (
      await pool.query(
        "SELECT r.grant_id FROM local_ai_test_unit_jobs b JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id WHERE b.job_id=$1",
        [queued.jobId],
      )
    ).rows[0].grant_id,
  ).toBe(ids[0]);
  expect(await balance(ids[1]!)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
    expired: 0,
  });
});
it("an explicit sweep preserves the pending hold and later withdrawal records expiry once", async () => {
  const owner = await fixture();
  const grantId = await grant(owner);
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected metered queue");
  await pool.query(
    "UPDATE synthetic_entitlement_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [grantId],
  );
  await ledger.expire(owner.id, grantId, randomUUID());
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 1,
    consumed: 0,
    expired: 0,
  });
  await local.withdraw(owner.token, owner.receiptId);
  expect(await balance(grantId)).toEqual({
    available: 0,
    reserved: 0,
    consumed: 0,
    expired: 1,
  });
  expect(execute).not.toHaveBeenCalled();
});
it.each(["consume", "formal-completion"] as const)(
  "%s rechecks a metered link created while it waits on reservation/grant locks",
  async (operation) => {
    const owner = await fixture();
    const grantId = await grant(owner);
    const legacy = await local.enqueue(
      owner.token,
      owner.receiptId,
      randomUUID(),
    );
    if (legacy.kind !== "queued") throw Error("Expected legacy queue");
    await pool.query("UPDATE adapter_jobs SET max_attempts=1 WHERE id=$1", [
      legacy.jobId,
    ]);
    const reservationId = await ledger.reserve(
      owner.id,
      grantId,
      1,
      randomUUID(),
    );
    const blocker = await pool.connect();
    let settlement: Promise<PromiseSettledResult<string>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT r.id FROM synthetic_entitlement_reservations r JOIN synthetic_entitlement_grants g ON g.id=r.grant_id WHERE r.id=$1 FOR UPDATE OF r,g",
        [reservationId],
      );
      const pid = (await blocker.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      settlement = Promise.allSettled([
        operation === "consume"
          ? ledger.consume(owner.id, reservationId, randomUUID())
          : ledger.settleCompletion(owner.id, reservationId, randomUUID(), {
              reference: "synthetic:concurrent-local-bypass",
              category: "study_requests",
              quantity: 1,
            }),
      ]);
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        blocked =
          Number(
            (
              await pool.query(
                "SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0].count,
          ) > 0;
        if (blocked) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(blocked).toBe(true);
      await blocker.query(
        "INSERT INTO local_ai_test_unit_jobs(job_id,member_id,reservation_id,policy) VALUES($1,$2,$3,'deterministic-request-test-v1')",
        [legacy.jobId, owner.id, reservationId],
      );
      await blocker.query("COMMIT");
      expect((await settlement)[0]!.status).toBe("rejected");
      expect(await balance(grantId)).toEqual({
        available: 0,
        reserved: 1,
        consumed: 0,
        expired: 0,
      });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await settlement;
    }
  },
);
