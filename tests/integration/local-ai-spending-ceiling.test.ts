import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { setTestCeiling } from "../support/ai-test-ceiling.ts";
import { migrate, store } from "../../src/store.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import {
  deterministicRegistry,
  type AdapterResult,
} from "../../src/adapters.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { localAiControlStore } from "../../src/local-ai-control.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";

// #188 AICAP scenarios: a test-only platform spending ceiling. Only the external provider boundary is stubbed, and
// every value is invented. Literal amounts below are the published test rates:
// 300 points per 1000 input tokens and 600 per 1000 output tokens, rounded up.
const SOURCE = "Invented source for private local practice"; // 42 bytes, 11 tokens
const MODEL = "simulated-model-v1";
const RATES = "simulated-rates-v1";
const ESTIMATE = {
  inputTokens: 11,
  outputTokens: 256,
  costPoints: 157,
  modelVersion: MODEL,
  rateVersion: RATES,
};

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
const evidence = evidenceStore(pool, objects, "synthetic-usage-local-secret");
const control = localAiControlStore(pool);

beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  await setTestCeiling(pool, { ceiling: 1000000, committed: 0 });
  data.clear();
  execute.mockReset();
  execute.mockImplementation(registry.adapter("ai", "test").execute);
});
afterAll(async () => {
  // Leave the shared switch and ceiling usable for later files.
  await pool.query("UPDATE local_ai_control SET paused=false");
  await setTestCeiling(pool, { ceiling: 100000, committed: 0 });
  await pool.end();
});

async function member() {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  return { token, id: session.learner.id };
}
async function permitted() {
  const owner = await member();
  const uploaded = await evidence.upload(owner.token, {
    name: "Invented-usage.txt",
    mediaType: "text/plain",
    data: Buffer.from(SOURCE),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw Error("Synthetic upload unavailable");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  const permission = await local.grant(owner.token, uploaded.id);
  if (permission.kind !== "granted") throw Error("Synthetic grant unavailable");
  return { ...owner, evidenceId: uploaded.id, receiptId: permission.receiptId };
}
async function grant(owner: { id: string }, category = "study_requests") {
  return ledger.grant(owner.id, category as "study_requests", 1, randomUUID(), {
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}
async function balance(grantId: string) {
  return (
    await pool.query(
      "SELECT available,reserved,consumed FROM synthetic_entitlement_grants WHERE id=$1",
      [grantId],
    )
  ).rows[0];
}
async function queued(owner: { token: string; receiptId: string }) {
  const outcome = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (outcome.kind !== "queued") throw Error("Expected metered queue");
  return outcome.jobId;
}
const stubUsage = (usage: unknown) =>
  execute.mockImplementationOnce(
    async (...args) =>
      ({
        ...(await registry.adapter("ai", "test").execute(...args)),
        usage,
      }) as AdapterResult,
  );
const held = { available: 0, reserved: 1, consumed: 0 };
const consumedOnce = { available: 0, reserved: 0, consumed: 1 };

const committed = async () =>
  Number(
    (await pool.query("SELECT committed_points FROM ai_test_spending_ceiling"))
      .rows[0].committed_points,
  );
const room = (points: number) => setTestCeiling(pool, { room: points });
const commitments = async (jobId: string) =>
  (
    await pool.query(
      "SELECT attempt,estimated_points,state,actual_points FROM ai_spending_commitments WHERE job_id=$1 ORDER BY attempt",
      [jobId],
    )
  ).rows;
const job = async (jobId: string) =>
  (
    await pool.query(
      "SELECT status,attempt_count FROM adapter_jobs WHERE id=$1",
      [jobId],
    )
  ).rows[0];

it("AICAP-01/05: commits the estimate before the call, then settles to the actual cost", async () => {
  const owner = await permitted();
  await grant(owner);
  const jobId = await queued(owner);
  expect(await committed()).toBe(0);
  let duringCall = -1;
  execute.mockImplementationOnce(async (...args) => {
    duringCall = await committed();
    return registry.adapter("ai", "test").execute(...args);
  });
  expect((await local.run(owner.token, jobId)).kind).toBe("completed");
  expect(duringCall).toBe(ESTIMATE.costPoints);
  expect(await committed()).toBe(42);
  expect(await commitments(jobId)).toEqual([
    { attempt: 1, estimated_points: 157, state: "settled", actual_points: 42 },
  ]);
  // Replay settles nothing twice.
  expect((await local.run(owner.token, jobId)).kind).toBe("completed");
  expect(await committed()).toBe(42);
});

it("AICAP-02: makes no provider call when the estimate would pass the ceiling, and withdrawal still restores the unit", async () => {
  const owner = await permitted();
  const grantId = await grant(owner);
  const jobId = await queued(owner);
  await room(ESTIMATE.costPoints - 1);
  expect(await local.run(owner.token, jobId)).toEqual({
    kind: "ceiling_reached",
    jobId,
  });
  expect(execute).not.toHaveBeenCalled();
  expect(await job(jobId)).toEqual({ status: "pending", attempt_count: 0 });
  expect(await balance(grantId)).toEqual(held);
  expect(await committed()).toBe(0);
  expect(await commitments(jobId)).toEqual([]);

  // Exactly enough room lets the same request run.
  await room(ESTIMATE.costPoints);
  expect((await local.run(owner.token, jobId)).kind).toBe("completed");
  expect(execute).toHaveBeenCalledTimes(1);

  const other = await permitted();
  const otherGrant = await grant(other);
  await room(1000);
  const waiting = await queued(other);
  await room(0);
  expect((await local.run(other.token, waiting)).kind).toBe("ceiling_reached");
  expect(await local.withdraw(other.token, other.receiptId)).toBe(true);
  expect(await balance(otherGrant)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("AICAP-03: holds no unit and creates no request when the ceiling has no room", async () => {
  const owner = await permitted();
  const grantId = await grant(owner);
  await room(ESTIMATE.costPoints - 1);
  expect(
    await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()),
  ).toEqual({ kind: "ceiling_reached" });
  expect(await balance(grantId)).toEqual({
    available: 1,
    reserved: 0,
    consumed: 0,
  });
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM adapter_jobs")).rows[0].n,
  ).toBe(0);
  // Unmetered simulations carry no estimate and are not counted.
  expect(
    (await local.enqueue(owner.token, owner.receiptId, randomUUID())).kind,
  ).toBe("queued");
});

it("AICAP-04: lets exactly one of two concurrent requests take the last room", async () => {
  const first = await permitted();
  const second = await permitted();
  const grants = [await grant(first), await grant(second)];
  const jobs = [await queued(first), await queued(second)];
  // Actual equals the estimate, so the order of settlement cannot reopen room.
  execute.mockImplementation(
    async (...args) =>
      ({
        ...(await registry.adapter("ai", "test").execute(...args)),
        usage: { inputTokens: 11, outputTokens: 256 },
      }) as AdapterResult,
  );
  await room(ESTIMATE.costPoints);
  const outcomes = await Promise.all([
    local.run(first.token, jobs[0]!),
    local.run(second.token, jobs[1]!),
  ]);
  expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
    "ceiling_reached",
    "completed",
  ]);
  expect(execute).toHaveBeenCalledTimes(1);
  const balances = [await balance(grants[0]!), await balance(grants[1]!)];
  expect(balances).toContainEqual(consumedOnce);
  expect(balances).toContainEqual(held);
  expect(await committed()).toBe(ESTIMATE.costPoints);
});

it("AICAP-05: counts an overrun in full, which closes the ceiling to later requests", async () => {
  const owner = await permitted();
  const grantId = await grant(owner);
  const jobId = await queued(owner);
  await room(1000);
  stubUsage({ inputTokens: 4000, outputTokens: 4000 });
  expect((await local.run(owner.token, jobId)).kind).toBe("completed");
  expect(await balance(grantId)).toEqual(consumedOnce);
  expect(await committed()).toBe(3600);

  const next = await permitted();
  await grant(next);
  expect(
    (await local.enqueueMetered(next.token, next.receiptId, randomUUID())).kind,
  ).toBe("ceiling_reached");
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
  ["an ambiguous provider failure", "throw"],
  ["missing usage", "missing"],
])("AICAP-06: keeps the estimate counted after %s", async (_name, outcome) => {
  const owner = await permitted();
  const grantId = await grant(owner);
  const jobId = await queued(owner);
  if (outcome === "throw")
    execute.mockRejectedValueOnce(Error("Invented provider timeout"));
  if (outcome === "missing") stubUsage(undefined);
  expect((await local.run(owner.token, jobId)).kind).toBe("unavailable");
  expect((await local.run(owner.token, jobId)).kind).toBe("unavailable");
  expect(await local.withdraw(owner.token, owner.receiptId)).toBe(true);
  expect(await committed()).toBe(ESTIMATE.costPoints);
  expect(await commitments(jobId)).toEqual([
    {
      attempt: 1,
      estimated_points: 157,
      state: "committed",
      actual_points: null,
    },
  ]);
  expect(await balance(grantId)).toEqual(held);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("AICAP-07: returns the estimate exactly once after a known failure before the call", async () => {
  const owner = await permitted();
  await grant(owner);
  const jobId = await queued(owner);
  const mismatched = localAiConsentStore(pool, objects, {
    mode: "test",
    adapter: () => ({ ...registry.adapter("ai", "test"), mode: "live" }),
  });
  expect((await mismatched.run(owner.token, jobId)).kind).toBe("denied");
  expect(execute).not.toHaveBeenCalled();
  expect(await committed()).toBe(0);
  expect(await commitments(jobId)).toEqual([
    {
      attempt: 1,
      estimated_points: 157,
      state: "restored",
      actual_points: null,
    },
  ]);
  expect((await mismatched.run(owner.token, jobId)).kind).not.toBe("completed");
  expect((await local.run(owner.token, jobId)).kind).not.toBe("completed");
  expect(await committed()).toBe(0);
  expect(execute).not.toHaveBeenCalled();
});

it("AICAP-07: refuses a commitment past the ceiling and any rewrite of a closed one", async () => {
  const owner = await permitted();
  await grant(owner);
  const jobId = await queued(owner);
  await local.run(owner.token, jobId);
  await room(0);
  await expect(
    pool.query(
      "UPDATE ai_spending_commitments SET state='restored',actual_points=NULL WHERE job_id=$1",
      [jobId],
    ),
  ).rejects.toThrow(/closed/);
  await expect(
    pool.query(
      "UPDATE ai_spending_commitments SET estimated_points=0 WHERE job_id=$1",
      [jobId],
    ),
  ).rejects.toThrow(/closed/);
  await expect(
    pool.query("DELETE FROM ai_spending_commitments WHERE job_id=$1", [jobId]),
  ).rejects.toThrow(/removed only with their request/);
  await expect(
    pool.query("UPDATE ai_test_spending_ceiling SET committed_points=-1"),
  ).rejects.toThrow();
});

it("AICAP-08: shows platform admins a content-free readout, and erasure keeps the spend", async () => {
  const token = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 60_000),
  );
  const owner = await permitted();
  await grant(owner);
  const jobId = await queued(owner);
  await local.run(owner.token, jobId);
  await setTestCeiling(pool, { ceiling: 5000 });
  const readout = await control.spending(token);
  expect(readout).toEqual({
    rateVersion: RATES,
    ceilingPoints: 5000,
    committedPoints: 42,
    remainingPoints: 4958,
  });
  expect(JSON.stringify(readout)).not.toContain(owner.id);
  expect(await control.spending(owner.token)).toBeNull();
  expect(await control.spending("unknown")).toBeNull();

  await pool.query("DELETE FROM learners WHERE id=$1", [owner.id]);
  expect(await commitments(jobId)).toEqual([]);
  expect(await committed()).toBe(42);
});

it("AICAP-09: a pause commits nothing and calls no provider, whatever the room", async () => {
  const owner = await permitted();
  await grant(owner);
  const jobId = await queued(owner);
  await pool.query("UPDATE local_ai_control SET paused=true");
  expect((await local.run(owner.token, jobId)).kind).toBe("denied");
  expect(await committed()).toBe(0);
  expect(await commitments(jobId)).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
});
