import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { setTestCeiling } from "../support/ai-test-ceiling.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { localAiControlStore } from "../../src/local-ai-control.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";

// #188 AICTL scenarios: a platform administrator changes the TEST spending
// ceiling (invented simulated points, not money) and every change is recorded.
// Only the external provider boundary is stubbed. The deterministic request
// below estimates 157 points and settles at 42 (see the AICAP file).
const SOURCE = "Invented source for private local practice";
const ESTIMATE_POINTS = 157;

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
const evidence = evidenceStore(pool, objects, "synthetic-ceiling-local-secret");
const control = localAiControlStore(pool);

beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  await setTestCeiling(pool, { ceiling: 1000, committed: 0 });
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

async function administrator() {
  const token = randomBytes(32).toString("hex");
  const id = await authorizationStore(pool).provisionStaff(
    token,
    "platform_admin",
    new Date(Date.now() + 600_000),
  );
  return { token, id };
}
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
    name: "Invented-ceiling.txt",
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
  await ledger.grant(owner.id, "study_requests", 1, randomUUID(), {
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return { ...owner, receiptId: permission.receiptId };
}
const ceiling = async () =>
  (
    await pool.query<{ ceiling_points: string; committed_points: string }>(
      "SELECT ceiling_points,committed_points FROM ai_test_spending_ceiling",
    )
  ).rows.map((r) => ({
    ceiling: Number(r.ceiling_points),
    committed: Number(r.committed_points),
  }))[0];
const changes = async () =>
  (
    await pool.query(
      "SELECT administrator_id,rate_version,previous_points::int AS previous,ceiling_points::int AS next,committed_points::int AS committed FROM ai_test_spending_ceiling_changes ORDER BY changed_at",
    )
  ).rows;
const change = (
  token: string,
  expectedPoints: number,
  ceilingPoints: number,
  key: string = randomUUID(),
) => control.setCeiling(token, { expectedPoints, ceilingPoints, key });

it("AICTL-01: raising a full test ceiling lets the member's next request fit", async () => {
  const admin = await administrator();
  const owner = await permitted();
  await setTestCeiling(pool, { ceiling: 100 });
  const refused = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  expect(refused.kind).toBe("ceiling_reached");
  expect(await change(admin.token, 100, 500)).toEqual({ kind: "changed" });
  expect(await ceiling()).toEqual({ ceiling: 500, committed: 0 });
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error(`Expected queue: ${queued.kind}`);
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("completed");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("AICTL-02: lowering below committed spend closes new calls and refunds nothing", async () => {
  const admin = await administrator();
  const owner = await permitted();
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected queue");
  await local.run(owner.token, queued.jobId);
  expect(await ceiling()).toEqual({ ceiling: 1000, committed: 42 });

  expect(await change(admin.token, 1000, 10)).toEqual({ kind: "changed" });
  expect(await ceiling()).toEqual({ ceiling: 10, committed: 42 });
  expect(await control.spending(admin.token)).toMatchObject({
    ceilingPoints: 10,
    committedPoints: 42,
    remainingPoints: 0,
  });
  const second = await permitted();
  expect(
    (await local.enqueueMetered(second.token, second.receiptId, randomUUID()))
      .kind,
  ).toBe("ceiling_reached");
  expect(execute).toHaveBeenCalledTimes(1);
  // Zero is a valid full stop.
  expect(await change(admin.token, 10, 0)).toEqual({ kind: "changed" });
  expect(await ceiling()).toEqual({ ceiling: 0, committed: 42 });
});

it("AICTL-03: records each change once, immutably, keeping it when the administrator is removed", async () => {
  const admin = await administrator();
  const owner = await permitted();
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected queue");
  await local.run(owner.token, queued.jobId);
  await change(admin.token, 1000, 2000);
  await change(admin.token, 2000, 1500);
  expect(await changes()).toEqual([
    {
      administrator_id: admin.id,
      rate_version: "simulated-rates-v1",
      previous: 1000,
      next: 2000,
      committed: 42,
    },
    {
      administrator_id: admin.id,
      rate_version: "simulated-rates-v1",
      previous: 2000,
      next: 1500,
      committed: 42,
    },
  ]);
  const history = await control.ceilingHistory(admin.token);
  expect(history?.map((h) => [h.previousPoints, h.ceilingPoints])).toEqual([
    [2000, 1500],
    [1000, 2000],
  ]);
  expect(history?.[0]?.changedAt).toBeInstanceOf(Date);
  expect(JSON.stringify(history)).not.toContain(owner.id);
  expect(await control.ceilingHistory(owner.token)).toBeNull();

  await expect(
    pool.query("UPDATE ai_test_spending_ceiling_changes SET ceiling_points=1"),
  ).rejects.toThrow(/immutable/);
  await expect(
    pool.query("DELETE FROM ai_test_spending_ceiling_changes"),
  ).rejects.toThrow(/immutable/);
  // An insert that skips the store still needs current platform authority
  // and the ceiling in force.
  await expect(
    pool.query(
      "INSERT INTO ai_test_spending_ceiling_changes(administrator_id,idempotency_key,rate_version,previous_points,ceiling_points,committed_points) VALUES($1,$2,'simulated-rates-v1',1500,9,42)",
      [owner.id, randomUUID()],
    ),
  ).rejects.toThrow(/authority/);
  await expect(
    pool.query(
      "INSERT INTO ai_test_spending_ceiling_changes(administrator_id,idempotency_key,rate_version,previous_points,ceiling_points,committed_points) VALUES($1,$2,'simulated-rates-v1',999,9,42)",
      [admin.id, randomUUID()],
    ),
  ).rejects.toThrow(/changed/);

  await pool.query("DELETE FROM principals WHERE id=$1", [admin.id]);
  expect((await changes()).map((c) => c.administrator_id)).toEqual([
    null,
    null,
  ]);
  expect(await ceiling()).toEqual({ ceiling: 1500, committed: 42 });
});

it("AICTL-04: a stale form changes nothing", async () => {
  const first = await administrator();
  const second = await administrator();
  expect(await change(second.token, 1000, 3000)).toEqual({ kind: "changed" });
  expect(await change(first.token, 1000, 50)).toEqual({ kind: "stale" });
  expect(await ceiling()).toEqual({ ceiling: 3000, committed: 0 });
  expect(await changes()).toHaveLength(1);
});

it("AICTL-05: a replayed submission makes one change; a reused key with other values conflicts", async () => {
  const admin = await administrator();
  const key = randomUUID();
  expect(await change(admin.token, 1000, 4000, key)).toEqual({
    kind: "changed",
  });
  expect(await change(admin.token, 1000, 4000, key)).toEqual({
    kind: "replayed",
  });
  expect(await change(admin.token, 1000, 4100, key)).toEqual({
    kind: "conflict",
  });
  expect(await ceiling()).toEqual({ ceiling: 4000, committed: 0 });
  expect(await changes()).toHaveLength(1);
});

it("AICTL-06: only a current platform administrator with a valid value changes it", async () => {
  const owner = await member();
  const operatorToken = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    operatorToken,
    "operator",
    new Date(Date.now() + 600_000),
  );
  expect(await change(owner.token, 1000, 2000)).toEqual({ kind: "denied" });
  expect(await change(operatorToken, 1000, 2000)).toEqual({ kind: "denied" });
  expect(await change("unknown", 1000, 2000)).toEqual({ kind: "denied" });
  const admin = await administrator();
  for (const [expected, next, key] of [
    [1000, -1, randomUUID()],
    [1000, 1.5, randomUUID()],
    [1000, 1_000_000_000_001, randomUUID()],
    [1000, 1000, randomUUID()],
    [-1, 5, randomUUID()],
    [1000, 5, "not-a-key"],
  ] as const)
    expect(await change(admin.token, expected, next, key)).toEqual({
      kind: "invalid",
    });
  await pool.query(
    "UPDATE principals SET revoked_at=clock_timestamp() WHERE token_hash=$1",
    [hash(admin.token)],
  );
  expect(await change(admin.token, 1000, 2000)).toEqual({ kind: "denied" });
  expect(await ceiling()).toEqual({ ceiling: 1000, committed: 0 });
  expect(await changes()).toEqual([]);
});

it("AICTL-07: a ceiling stop racing dispatch claims serializes with no lost update and no later call", async () => {
  const admin = await administrator();
  const owners = await Promise.all([1, 2, 3, 4].map(() => permitted()));
  const jobs: { token: string; jobId: string }[] = [];
  for (const owner of owners) {
    const queued = await local.enqueueMetered(
      owner.token,
      owner.receiptId,
      randomUUID(),
    );
    if (queued.kind !== "queued") throw Error("Expected queue");
    jobs.push({ token: owner.token, jobId: queued.jobId });
  }
  const [stopped, ...outcomes] = await Promise.all([
    change(admin.token, 1000, 0),
    ...jobs.map((j) => local.run(j.token, j.jobId)),
  ]);
  expect(stopped).toEqual({ kind: "changed" });
  for (const outcome of outcomes)
    expect(["completed", "ceiling_reached"]).toContain(outcome.kind);
  const completed = outcomes.filter((o) => o.kind === "completed").length;
  expect(execute).toHaveBeenCalledTimes(completed);
  expect(await ceiling()).toEqual({ ceiling: 0, committed: completed * 42 });
  const [record] = await changes();
  expect(record).toMatchObject({ previous: 1000, next: 0 });
  // Every claim made before the stop is in its snapshot, settled or not.
  expect(record.committed).toBeLessThanOrEqual(completed * ESTIMATE_POINTS);
  // Nothing reaches the provider afterwards.
  const late = await permitted();
  expect(
    (await local.enqueueMetered(late.token, late.receiptId, randomUUID())).kind,
  ).toBe("ceiling_reached");
  expect(execute).toHaveBeenCalledTimes(completed);
});

it("AICTL-09: the database refuses an unrecorded change to the test ceiling", async () => {
  for (const sql of [
    "UPDATE ai_test_spending_ceiling SET ceiling_points=5000",
    "UPDATE ai_test_spending_ceiling SET ceiling_points=0",
    "UPDATE ai_test_spending_ceiling SET rate_version='simulated-rates-v2'",
    "INSERT INTO ai_test_spending_ceiling(singleton,rate_version,ceiling_points,committed_points) VALUES(true,'simulated-rates-v1',5000,0) ON CONFLICT(singleton) DO UPDATE SET ceiling_points=5000",
  ])
    await expect(pool.query(sql), sql).rejects.toThrow(
      /AI test ceiling changes only through a recorded change/,
    );
  // Setting the guard's own marker by hand does not help a direct update.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('dne.ai_test_ceiling_change','1000:5000',true)",
    );
    await expect(
      client.query("UPDATE ai_test_spending_ceiling SET ceiling_points=5000"),
    ).rejects.toThrow(/recorded change/);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  expect(await ceiling()).toEqual({ ceiling: 1000, committed: 0 });
  expect(await changes()).toEqual([]);
});

it("AICTL-10: the committed total moves only with its commitments", async () => {
  const owner = await permitted();
  const queued = await local.enqueueMetered(
    owner.token,
    owner.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Expected queue");
  expect((await local.run(owner.token, queued.jobId)).kind).toBe("completed");
  expect(await ceiling()).toEqual({ ceiling: 1000, committed: 42 });
  for (const sql of [
    "UPDATE ai_test_spending_ceiling SET committed_points=0",
    "UPDATE ai_test_spending_ceiling SET committed_points=committed_points+1",
  ])
    await expect(pool.query(sql), sql).rejects.toThrow(
      /AI test ceiling changes only through a recorded change/,
    );
  expect(await ceiling()).toEqual({ ceiling: 1000, committed: 42 });
});

it("AICTL-11: the ceiling row cannot be removed", async () => {
  await expect(
    pool.query("DELETE FROM ai_test_spending_ceiling"),
  ).rejects.toThrow(/AI test ceiling cannot be removed/);
  await expect(pool.query("TRUNCATE ai_test_spending_ceiling")).rejects.toThrow(
    /AI test ceiling cannot be removed/,
  );
  expect(await ceiling()).toEqual({ ceiling: 1000, committed: 0 });
});

it("AICTL-12: a recorded administrator change still applies, once", async () => {
  const admin = await administrator();
  const key = randomUUID();
  expect(await change(admin.token, 1000, 3000, key)).toEqual({
    kind: "changed",
  });
  expect(await change(admin.token, 1000, 3000, key)).toEqual({
    kind: "replayed",
  });
  expect(await ceiling()).toEqual({ ceiling: 3000, committed: 0 });
  expect(await changes()).toEqual([
    {
      administrator_id: admin.id,
      rate_version: "simulated-rates-v1",
      previous: 1000,
      next: 3000,
      committed: 0,
    },
  ]);
  // A direct update afterwards is still refused.
  await expect(
    pool.query("UPDATE ai_test_spending_ceiling SET ceiling_points=1000"),
  ).rejects.toThrow(/recorded change/);
});
