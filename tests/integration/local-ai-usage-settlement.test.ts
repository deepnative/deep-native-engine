import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import {
  deterministicRegistry,
  type AdapterResult,
} from "../../src/adapters.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { memberExportStore } from "../../src/member-export.ts";

// #188 AIUSE scenarios. Only the external provider boundary is stubbed, and
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
const exports = memberExportStore(pool);

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
const rows = async (table: string, jobId: string) =>
  (await pool.query(`SELECT * FROM ${table} WHERE job_id=$1`, [jobId])).rows;

it("AIUSE-01/02: shows a labelled estimate, then settles actual usage exactly once", async () => {
  const owner = await permitted();
  const grantId = await grant(owner);
  const [choice] = await local.list(owner.token);
  expect(choice!.estimate).toEqual(ESTIMATE);

  const jobId = await queued(owner);
  expect(execute).not.toHaveBeenCalled();
  const [pending] = await local.list(owner.token);
  expect(pending!.jobs[0]!.budget).toEqual({ estimate: ESTIMATE });

  expect((await local.run(owner.token, jobId)).kind).toBe("completed");
  expect((await local.run(owner.token, jobId)).kind).toBe("completed");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await balance(grantId)).toEqual(consumedOnce);

  const [settled] = await local.list(owner.token);
  expect(settled!.jobs[0]!.budget).toEqual({
    estimate: ESTIMATE,
    actual: { inputTokens: 11, outputTokens: 64, costPoints: 42 },
  });
  expect(await rows("ai_usage_settlements", jobId)).toHaveLength(1);
});

it("AIUSE-02: refuses a duplicate settlement and any change to a recorded amount", async () => {
  const owner = await permitted();
  await grant(owner);
  const jobId = await queued(owner);
  await local.run(owner.token, jobId);

  await expect(
    pool.query(
      "INSERT INTO ai_usage_settlements(job_id,member_id,input_tokens,output_tokens,cost_points) VALUES($1,$2,1,1,1)",
      [jobId, owner.id],
    ),
  ).rejects.toThrow();
  await expect(
    pool.query(
      "UPDATE ai_usage_settlements SET cost_points=0 WHERE job_id=$1",
      [jobId],
    ),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query("UPDATE ai_usage_estimates SET cost_points=0 WHERE job_id=$1", [
      jobId,
    ]),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query("DELETE FROM ai_usage_settlements WHERE job_id=$1", [jobId]),
  ).rejects.toThrow(/member erasure/);
  await expect(
    pool.query("DELETE FROM ai_usage_estimates WHERE job_id=$1", [jobId]),
  ).rejects.toThrow(/member erasure/);
});

it("AIUSE-03: refuses settlement before the reservation is consumed", async () => {
  const owner = await permitted();
  const grantId = await grant(owner);
  const jobId = await queued(owner);
  await expect(
    pool.query(
      "INSERT INTO ai_usage_settlements(job_id,member_id,input_tokens,output_tokens,cost_points) VALUES($1,$2,1,1,1)",
      [jobId, owner.id],
    ),
  ).rejects.toThrow(/out of order/);
  expect(await balance(grantId)).toEqual(held);
});

it.each([
  ["missing", undefined],
  ["text", { inputTokens: "11", outputTokens: "64" }],
  ["fractional", { inputTokens: 1.5, outputTokens: 64 }],
  ["negative", { inputTokens: 11, outputTokens: -1 }],
  ["zero input", { inputTokens: 0, outputTokens: 64 }],
  ["out of range", { inputTokens: 11, outputTokens: 10_000_001 }],
])(
  "AIUSE-04: holds the unit when the provider reports %s usage",
  async (_name, usage) => {
    const owner = await permitted();
    const grantId = await grant(owner);
    const jobId = await queued(owner);
    stubUsage(usage);
    expect(await local.run(owner.token, jobId)).toEqual({
      kind: "unavailable",
      jobId,
      status: "needs_reconciliation",
    });
    expect(await balance(grantId)).toEqual(held);
    expect(await rows("ai_usage_settlements", jobId)).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1);

    // Neither a replay nor withdrawal refunds or redispatches.
    expect((await local.run(owner.token, jobId)).kind).toBe("unavailable");
    expect(await local.withdraw(owner.token, owner.receiptId)).toBe(true);
    expect(await balance(grantId)).toEqual(held);
    expect(execute).toHaveBeenCalledTimes(1);
    const [choice] = await local.list(owner.token);
    expect(choice!.jobs[0]!.status).toBe("needs_reconciliation");
    expect(choice!.jobs[0]!.budget).toEqual({ estimate: ESTIMATE });
  },
);

it("AIUSE-05: charges one unit and marks an overrun above the estimate", async () => {
  const owner = await permitted();
  const grantId = await grant(owner);
  const jobId = await queued(owner);
  stubUsage({ inputTokens: 4000, outputTokens: 4000 });
  expect((await local.run(owner.token, jobId)).kind).toBe("completed");
  expect(await balance(grantId)).toEqual(consumedOnce);
  const [choice] = await local.list(owner.token);
  expect(choice!.jobs[0]!.budget!.actual).toEqual({
    inputTokens: 4000,
    outputTokens: 4000,
    costPoints: 3600,
  });
  expect(choice!.jobs[0]!.budget!.actual!.costPoints).toBeGreaterThan(
    ESTIMATE.costPoints,
  );
});

it.each([
  ["no estimate", "DELETE"],
  ["a retired rate version", "RETIRE"],
])(
  "AIUSE-06: never calls the provider with %s, and withdrawal restores the unit",
  async (_name, change) => {
    const owner = await permitted();
    const grantId = await grant(owner);
    const jobId = await queued(owner);
    // Models a request queued before estimates existed or under older rates.
    await pool.query(
      "ALTER TABLE ai_usage_estimates DISABLE TRIGGER USER; ALTER TABLE ai_usage_settlements DISABLE TRIGGER USER",
    );
    try {
      await pool.query(
        change === "DELETE"
          ? "DELETE FROM ai_usage_estimates WHERE job_id=$1"
          : "UPDATE ai_usage_estimates SET rate_version='retired-test-rates-v0' WHERE job_id=$1",
        [jobId],
      );
    } finally {
      await pool.query(
        "ALTER TABLE ai_usage_estimates ENABLE TRIGGER USER; ALTER TABLE ai_usage_settlements ENABLE TRIGGER USER",
      );
    }
    expect((await local.run(owner.token, jobId)).kind).toBe("denied");
    expect(execute).not.toHaveBeenCalled();
    expect(await balance(grantId)).toEqual(held);
    const [job] = (
      await pool.query(
        "SELECT status,attempt_count FROM adapter_jobs WHERE id=$1",
        [jobId],
      )
    ).rows;
    expect(job).toEqual({ status: "pending", attempt_count: 0 });
    expect(await local.withdraw(owner.token, owner.receiptId)).toBe(true);
    expect(await balance(grantId)).toEqual({
      available: 1,
      reserved: 0,
      consumed: 0,
    });
  },
);

it("AIUSE-07: rolls back together when settlement fails and never calls the provider twice", async () => {
  const owner = await permitted();
  const grantId = await grant(owner);
  const jobId = await queued(owner);
  await pool.query(`CREATE OR REPLACE FUNCTION aiuse_07_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Invented settlement crash'; END $$`);
  try {
    await pool.query(
      "CREATE TRIGGER aiuse_07 BEFORE INSERT ON ai_usage_settlements FOR EACH ROW EXECUTE FUNCTION aiuse_07_fail()",
    );
    expect((await local.run(owner.token, jobId)).kind).toBe("unavailable");
  } finally {
    await pool.query("DROP TRIGGER IF EXISTS aiuse_07 ON ai_usage_settlements");
    await pool.query("DROP FUNCTION aiuse_07_fail()");
  }
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await balance(grantId)).toEqual(held);
  expect(await rows("ai_usage_settlements", jobId)).toHaveLength(0);
  const job = async () =>
    (
      await pool.query(
        "SELECT status,provider_operation_reference FROM adapter_jobs WHERE id=$1",
        [jobId],
      )
    ).rows[0];
  expect(await job()).toEqual({
    status: "running",
    provider_operation_reference: null,
  });

  expect((await local.run(owner.token, jobId)).kind).toBe("unavailable");
  await pool.query(
    "UPDATE adapter_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [jobId],
  );
  expect(await local.run(owner.token, jobId)).toEqual({
    kind: "unavailable",
    jobId,
    status: "needs_reconciliation",
  });
  expect((await job()).status).toBe("needs_reconciliation");
  expect(await balance(grantId)).toEqual(held);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("AIUSE-08: stores no provider text, exports the member's own figures, and erases them", async () => {
  const owner = await permitted();
  await grant(owner);
  const jobId = await queued(owner);
  const secret = "INVENTED-PRIVATE-PROVIDER-TEXT";
  stubUsage({ inputTokens: 11, outputTokens: 64, prompt: secret, raw: secret });
  expect((await local.run(owner.token, jobId)).kind).toBe("completed");

  const stored = JSON.stringify([
    await rows("ai_usage_estimates", jobId),
    await rows("ai_usage_settlements", jobId),
    await local.list(owner.token),
  ]);
  expect(stored).not.toContain(secret);
  expect(stored).not.toContain(SOURCE);
  expect(
    Object.keys((await rows("ai_usage_settlements", jobId))[0]!).sort(),
  ).toEqual([
    "cost_points",
    "input_tokens",
    "job_id",
    "member_id",
    "output_tokens",
    "settled_at",
  ]);

  const exported = await exports.exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Expected a member export");
  expect(
    (exported.payload.records as unknown as Record<string, unknown>).aiUsage,
  ).toEqual([
    expect.objectContaining({
      jobId,
      modelVersion: MODEL,
      rateVersion: RATES,
      estimatedInputTokens: 11,
      estimatedOutputTokens: 256,
      estimatedCostPoints: 157,
      actualInputTokens: 11,
      actualOutputTokens: 64,
      actualCostPoints: 42,
      label: "ESTIMATE · SIMULATED · NO MONEY CHARGED",
    }),
  ]);
  expect(JSON.stringify(exported.payload)).not.toContain(secret);

  // Another member's export carries none of these figures.
  const other = await member();
  const foreign = await exports.exportOwned(other.token);
  if (foreign.kind !== "ready") throw Error("Expected a member export");
  expect(
    (foreign.payload.records as unknown as Record<string, unknown>).aiUsage,
  ).toEqual([]);

  await pool.query("DELETE FROM learners WHERE id=$1", [owner.id]);
  expect(await rows("ai_usage_estimates", jobId)).toHaveLength(0);
  expect(await rows("ai_usage_settlements", jobId)).toHaveLength(0);
});

it("AIUSE-09: a pause creates no estimate and calls no provider", async () => {
  const owner = await permitted();
  const grantId = await grant(owner);
  await pool.query("UPDATE local_ai_control SET paused=true");
  expect(
    (await local.enqueueMetered(owner.token, owner.receiptId, randomUUID()))
      .kind,
  ).toBe("denied");
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM ai_usage_estimates"))
      .rows[0].n,
  ).toBe(0);
  await pool.query("UPDATE local_ai_control SET paused=false");
  const jobId = await queued(owner);
  await pool.query("UPDATE local_ai_control SET paused=true");
  expect((await local.run(owner.token, jobId)).kind).toBe("denied");
  expect(execute).not.toHaveBeenCalled();
  expect(await balance(grantId)).toEqual(held);
});

it("AIUSE-09: leaves other allowance categories and unmetered requests untouched", async () => {
  const owner = await permitted();
  const studyGrant = await grant(owner);
  const coachGrant = await grant(owner, "coach_minutes");
  const before = await balance(coachGrant);
  const unmetered = await local.enqueue(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (unmetered.kind !== "queued") throw Error("Expected unmetered queue");
  expect((await local.run(owner.token, unmetered.jobId)).kind).toBe(
    "completed",
  );
  expect(await rows("ai_usage_estimates", unmetered.jobId)).toHaveLength(0);
  expect(await rows("ai_usage_settlements", unmetered.jobId)).toHaveLength(0);
  const [listed] = await local.list(owner.token);
  expect(listed!.jobs[0]!.budget).toBeUndefined();
  // Only a metered request may carry an estimate.
  await expect(
    pool.query(
      "INSERT INTO ai_usage_estimates(job_id,member_id,rate_version,model_version,input_tokens,output_tokens,cost_points) VALUES($1,$2,$3,$4,1,1,1)",
      [unmetered.jobId, owner.id, RATES, MODEL],
    ),
  ).rejects.toThrow(/metered/);

  const jobId = await queued(owner);
  expect((await local.run(owner.token, jobId)).kind).toBe("completed");
  expect(await balance(studyGrant)).toEqual(consumedOnce);
  expect(await balance(coachGrant)).toEqual(before);
});
