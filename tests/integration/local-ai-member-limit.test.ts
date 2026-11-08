import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import {
  LOCAL_AI_MEMBER_OPEN_LIMIT,
  localAiConsentStore,
} from "../../src/local-ai-consent.ts";
import { syntheticLedger } from "../../src/ledger.ts";

// #190 AILIMIT scenarios: a member-wide limit on unfinished AI requests,
// checked before any test unit, estimate, ceiling commitment or provider call.
// Only the external provider boundary is stubbed; every value is invented.
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
const evidence = evidenceStore(pool, objects, "synthetic-limit-local-secret");

beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals, cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  await pool.query(
    "UPDATE ai_test_spending_ceiling SET ceiling_points=1000000,committed_points=0",
  );
  data.clear();
  execute.mockReset();
  execute.mockImplementation(registry.adapter("ai", "test").execute);
});
afterAll(async () => {
  await pool.query("UPDATE local_ai_control SET paused=false");
  await pool.query(
    "UPDATE ai_test_spending_ceiling SET ceiling_points=100000,committed_points=0",
  );
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
/** One clean invented source with current permission. */
async function source(owner: { token: string }, n: number) {
  const uploaded = await evidence.upload(owner.token, {
    name: `Invented-limit-${n}.txt`,
    mediaType: "text/plain",
    data: Buffer.from(`Invented source ${n} for private local practice`),
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
  return permission.receiptId;
}
async function sources(owner: { token: string }, count: number) {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) ids.push(await source(owner, n));
  return ids;
}
const metered = (token: string, receiptId: string, key = randomUUID()) =>
  local.enqueueMetered(token, receiptId, key);
async function queued(token: string, receiptId: string) {
  const outcome = await metered(token, receiptId);
  if (outcome.kind !== "queued") throw Error(`Expected queue: ${outcome.kind}`);
  return outcome.jobId;
}
const footprint = async (memberId: string) =>
  (
    await pool.query(
      `SELECT
        (SELECT count(*)::int FROM adapter_jobs WHERE member_id=$1) AS jobs,
        (SELECT count(*)::int FROM ai_usage_estimates WHERE member_id=$1) AS estimates,
        (SELECT COALESCE(sum(reserved),0)::int FROM synthetic_entitlement_grants WHERE member_id=$1) AS held,
        (SELECT committed_points::int FROM ai_test_spending_ceiling) AS committed`,
      [memberId],
    )
  ).rows[0];

it("AILIMIT-01: one more request past the limit is refused with nothing held, stored or sent", async () => {
  expect(LOCAL_AI_MEMBER_OPEN_LIMIT).toBe(3);
  const owner = await member(5);
  const [a, b, c, d] = await sources(owner, 4);
  for (const receiptId of [a!, b!, c!]) await queued(owner.token, receiptId);
  const before = await footprint(owner.id);
  expect(before).toEqual({ jobs: 3, estimates: 3, held: 3, committed: 0 });
  expect(await metered(owner.token, d!)).toEqual({ kind: "limit_reached" });
  // The unmetered simulation shares the same limit.
  expect(await local.enqueue(owner.token, d!, d!)).toEqual({
    kind: "limit_reached",
  });
  expect(await footprint(owner.id)).toEqual(before);
  expect(execute).not.toHaveBeenCalled();
});

it("AILIMIT-02: a finished or withdrawn request frees a place", async () => {
  const owner = await member(5);
  const [a, b, c, d, e] = await sources(owner, 5);
  const first = await queued(owner.token, a!);
  await queued(owner.token, b!);
  await queued(owner.token, c!);
  expect((await metered(owner.token, d!)).kind).toBe("limit_reached");
  expect((await local.run(owner.token, first)).kind).toBe("completed");
  await queued(owner.token, d!);
  expect((await metered(owner.token, e!)).kind).toBe("limit_reached");
  expect(await local.withdraw(owner.token, b!)).toBe(true);
  await queued(owner.token, e!);
});

it("AILIMIT-03: an uncertain held request keeps its place and is never retried to make room", async () => {
  const owner = await member(5);
  const [a, b, c, d] = await sources(owner, 4);
  const uncertain = await queued(owner.token, a!);
  execute.mockRejectedValueOnce(Error("Invented provider timeout"));
  await local.run(owner.token, uncertain);
  expect(
    (
      await pool.query("SELECT status FROM adapter_jobs WHERE id=$1", [
        uncertain,
      ])
    ).rows[0].status,
  ).toBe("needs_reconciliation");
  await queued(owner.token, b!);
  await queued(owner.token, c!);
  expect((await metered(owner.token, d!)).kind).toBe("limit_reached");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("AILIMIT-04: requests queued at once never pass the limit", async () => {
  const owner = await member(8);
  const receipts = await sources(owner, 6);
  const outcomes = await Promise.all(
    receipts.map((receiptId) => metered(owner.token, receiptId)),
  );
  expect(outcomes.filter((o) => o.kind === "queued")).toHaveLength(3);
  expect(outcomes.filter((o) => o.kind === "limit_reached")).toHaveLength(3);
  expect(await footprint(owner.id)).toMatchObject({
    jobs: 3,
    estimates: 3,
    held: 3,
  });
});

it("AILIMIT-05: a replay is still answered at the limit, and other members do not count", async () => {
  const owner = await member(5);
  const [a, b, c] = await sources(owner, 3);
  const key = randomUUID();
  const outcome = await metered(owner.token, a!, key);
  if (outcome.kind !== "queued") throw Error("Expected queue");
  await queued(owner.token, b!);
  await queued(owner.token, c!);
  expect(await metered(owner.token, a!, key)).toEqual(outcome);
  const other = await member(1);
  const [own] = await sources(other, 1);
  expect((await metered(other.token, own!)).kind).toBe("queued");
});
