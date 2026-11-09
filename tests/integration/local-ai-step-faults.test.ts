import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { setTestCeiling } from "../support/ai-test-ceiling.ts";
import { migrate, store } from "../../src/store.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import {
  LOCAL_AI_STEP_DEADLINE_MS,
  localAiConsentStore,
} from "../../src/local-ai-consent.ts";
import { syntheticLedger } from "../../src/ledger.ts";

// #190 AIFAULT scenarios: the AI step has a fixed deadline, a started step
// that misses it stays held as a timeout, and the member's page names the real
// failure. Only the external AI boundary is stubbed; every value is invented.
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
const answer = registry.adapter("ai", "test").execute;
const execute = vi.fn(answer);
const DEADLINE = 150;
const local = localAiConsentStore(
  pool,
  objects,
  {
    mode: "test",
    adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
  },
  { stepDeadlineMs: DEADLINE },
);
const evidence = evidenceStore(pool, objects, "synthetic-fault-local-secret");

beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  await setTestCeiling(pool, { ceiling: 1000000, committed: 0 });
  data.clear();
  execute.mockReset();
  execute.mockImplementation(answer);
});
afterAll(async () => {
  await setTestCeiling(pool, { ceiling: 100000, committed: 0 });
  await pool.end();
});

async function member(units = 0) {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background: "explorer", goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Synthetic member unavailable");
  if (units)
    await ledger.grant(
      session.learner.id,
      "study_requests",
      units,
      randomUUID(),
      {
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    );
  return { token, id: session.learner.id };
}
async function source(token: string) {
  const uploaded = await evidence.upload(token, {
    name: `Invented-fault-${randomUUID()}.txt`,
    mediaType: "text/plain",
    data: Buffer.from("Invented source for a private local simulation"),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw Error("Synthetic upload unavailable");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  const permission = await local.grant(token, uploaded.id);
  if (permission.kind !== "granted") throw Error("Synthetic grant unavailable");
  return permission.receiptId;
}
async function queued(token: string, metered = false) {
  const receiptId = await source(token);
  const outcome = metered
    ? await local.enqueueMetered(token, receiptId, randomUUID())
    : await local.enqueue(token, receiptId, randomUUID());
  if (outcome.kind !== "queued") throw Error(`Expected queue: ${outcome.kind}`);
  return outcome.jobId;
}
const job = async (id: string) =>
  (
    await pool.query(
      `SELECT j.status,j.safe_error,j.attempt_count,
        (SELECT r.state FROM local_ai_test_unit_jobs b JOIN synthetic_entitlement_reservations r ON r.id=b.reservation_id WHERE b.job_id=j.id) AS unit,
        (SELECT string_agg(c.state,',' ORDER BY c.attempt) FROM ai_spending_commitments c WHERE c.job_id=j.id) AS commitments,
        (SELECT count(*)::int FROM ai_usage_settlements s WHERE s.job_id=j.id) AS settlements,
        (SELECT committed_points::int FROM ai_test_spending_ceiling) AS committed
      FROM adapter_jobs j WHERE j.id=$1`,
      [id],
    )
  ).rows[0];
async function listed(token: string, id: string) {
  for (const choice of await local.list(token))
    for (const item of choice.jobs) if (item.id === id) return item;
  throw Error("Listed job absent");
}
/** An AI step that never answers on its own; `late` answers after the deadline. */
function silentStep() {
  let late: () => void = () => {};
  execute.mockImplementation(
    (operation, input) =>
      new Promise((resolve) => {
        late = () => void answer(operation, input).then(resolve);
      }),
  );
  return () => late();
}
const malformed = () =>
  execute.mockImplementation(async (operation, input) => ({
    ...(await answer(operation, input)),
    message: "",
  }));

it("AIFAULT-00: the AI step has a fixed deadline well inside the claim", () => {
  expect(LOCAL_AI_STEP_DEADLINE_MS).toBe(5_000);
});

it("AIFAULT-01: a simulation that misses the deadline is held as a timeout and not retried", async () => {
  const owner = await member();
  const id = await queued(owner.token);
  silentStep();
  const started = Date.now();
  expect(await local.run(owner.token, id)).toEqual({
    kind: "unavailable",
    jobId: id,
    status: "needs_reconciliation",
  });
  expect(Date.now() - started).toBeLessThan(DEADLINE + 3_000);
  expect(await job(id)).toMatchObject({
    status: "needs_reconciliation",
    safe_error: "provider_timeout",
    attempt_count: 1,
  });
  expect(await listed(owner.token, id)).toMatchObject({
    status: "needs_reconciliation",
    failure: "timeout",
  });
  expect((await listed(owner.token, id)).canRetry).toBeUndefined();
  // Running it again never sends it a second time.
  expect(await local.run(owner.token, id)).toMatchObject({
    kind: "unavailable",
    status: "needs_reconciliation",
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("AIFAULT-02: a timed-out test request keeps its unit and ceiling points held once, and a late answer changes nothing", async () => {
  const owner = await member(2);
  const id = await queued(owner.token, true);
  const late = silentStep();
  expect(await local.run(owner.token, id)).toMatchObject({
    kind: "unavailable",
    status: "needs_reconciliation",
  });
  const held = await job(id);
  expect(held).toMatchObject({
    status: "needs_reconciliation",
    safe_error: "provider_timeout",
    unit: "reserved",
    commitments: "committed",
    settlements: 0,
  });
  expect(held.committed).toBeGreaterThan(0);
  late();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await job(id)).toEqual(held);
  expect(await listed(owner.token, id)).toMatchObject({
    failure: "timeout",
    testUnitState: "reserved",
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

it("AIFAULT-03: a malformed simulation answer is named, and the member can try again up to the attempt limit", async () => {
  const owner = await member();
  const id = await queued(owner.token);
  malformed();
  expect(await local.run(owner.token, id)).toEqual({
    kind: "unavailable",
    jobId: id,
    status: "failed",
  });
  expect(await job(id)).toMatchObject({
    status: "failed",
    safe_error: "invalid_provider_response",
    attempt_count: 1,
  });
  expect(await listed(owner.token, id)).toMatchObject({
    status: "failed",
    failure: "malformed",
    canRetry: true,
  });
  // A well-formed answer on the next try completes it.
  execute.mockImplementation(answer);
  expect(await local.run(owner.token, id)).toMatchObject({
    kind: "completed",
    status: "succeeded",
  });
  const done = await listed(owner.token, id);
  expect(done.status).toBe("succeeded");
  expect(done.failure).toBeUndefined();
  expect(done.canRetry).toBeUndefined();
});

it("AIFAULT-04: after the third malformed answer no further try is offered", async () => {
  const owner = await member();
  const id = await queued(owner.token);
  malformed();
  for (let attempt = 1; attempt <= 3; attempt++)
    await local.run(owner.token, id);
  expect(await job(id)).toMatchObject({ status: "failed", attempt_count: 3 });
  const item = await listed(owner.token, id);
  expect(item).toMatchObject({ failure: "malformed" });
  expect(item.canRetry).toBeUndefined();
  expect(await local.run(owner.token, id)).toMatchObject({
    status: "exhausted",
  });
  expect(execute).toHaveBeenCalledTimes(3);
});

it("AIFAULT-05: a malformed answer to a test request stays held with its unit, as an unknown outcome", async () => {
  const owner = await member(2);
  const id = await queued(owner.token, true);
  malformed();
  await local.run(owner.token, id);
  expect(await job(id)).toMatchObject({
    status: "needs_reconciliation",
    safe_error: "provider_outcome_unknown",
    unit: "reserved",
    settlements: 0,
  });
  const item = await listed(owner.token, id);
  expect(item.failure).toBeUndefined();
  expect(item.canRetry).toBeUndefined();
});

it("AIFAULT-06: a provider error that is not a timeout stays an unknown outcome", async () => {
  const owner = await member();
  const id = await queued(owner.token);
  execute.mockRejectedValue(Error("Invented provider failure"));
  await local.run(owner.token, id);
  expect(await job(id)).toMatchObject({
    status: "needs_reconciliation",
    safe_error: "provider_outcome_unknown",
  });
  expect((await listed(owner.token, id)).failure).toBeUndefined();
});
