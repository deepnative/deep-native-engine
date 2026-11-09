import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { syntheticLedger } from "../../src/ledger.ts";

// #42 AIKEY: local-AI request keys are unique per member, so another member's
// key reads and acts exactly like an unused one. Every value is invented.
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
const evidence = evidenceStore(pool, objects, "synthetic-keys-local-secret");

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
    name: `Invented-keys-${n}.txt`,
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
const metered = (
  token: string,
  receiptId: string,
  key: string = randomUUID(),
) => local.enqueueMetered(token, receiptId, key);
const jobs = async (memberId: string) =>
  (
    await pool.query<{ id: string; idempotency_key: string }>(
      "SELECT id,idempotency_key FROM adapter_jobs WHERE member_id=$1 ORDER BY created_at",
      [memberId],
    )
  ).rows;
const held = async (memberId: string) =>
  (
    await pool.query<{ held: number }>(
      "SELECT COALESCE(sum(reserved),0)::int AS held FROM synthetic_entitlement_grants WHERE member_id=$1",
      [memberId],
    )
  ).rows[0]!.held;

it("AIKEY-01 another member's used key reads and acts exactly like an unused one", async () => {
  const a = await member(2),
    b = await member(2);
  const [ra] = await sources(a, 1),
    [rb] = await sources(b, 1);
  const key = "invented-shared-key";
  const first = await metered(a.token, ra!, key);
  expect(first.kind).toBe("queued");
  // The same key from another member starts their own request.
  const other = await metered(b.token, rb!, key);
  expect(other.kind).toBe("queued");
  expect(other).not.toEqual(first);
  expect(await jobs(b.id)).toHaveLength(1);
  expect(await held(b.id)).toBe(1);
  // Unmetered requests behave the same way.
  const [rb2] = await sources(b, 1);
  expect((await local.enqueue(b.token, rb2!, "invented-plain-key")).kind).toBe(
    "queued",
  );
  const [ra2] = await sources(a, 1);
  expect((await local.enqueue(a.token, ra2!, "invented-plain-key")).kind).toBe(
    "queued",
  );
});

it("AIKEY-02 a member's own replay returns the same request, and their key on another source conflicts", async () => {
  const a = await member(3);
  const [r1, r2] = await sources(a, 2);
  const first = await metered(a.token, r1!, "invented-own-key");
  expect(await metered(a.token, r1!, "invented-own-key")).toEqual(first);
  expect(await metered(a.token, r2!, "invented-own-key")).toEqual({
    kind: "conflict",
  });
  expect(await jobs(a.id)).toHaveLength(1);
  expect(await held(a.id)).toBe(1);
});

it("AIKEY-03 a request queued before the change replays for its owner and frees nothing for others", async () => {
  const a = await member(2),
    b = await member(2);
  const [ra] = await sources(a, 1),
    [rb] = await sources(b, 1);
  const first = await metered(a.token, ra!, "invented-legacy-key");
  if (first.kind !== "queued") throw Error("Expected a queued request");
  // Store A's row the way keys were stored before #42.
  // Test setup only: the job identity is otherwise immutable.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(
      "UPDATE adapter_jobs SET idempotency_key=$2 WHERE id=$1",
      [first.jobId, "local-ai:" + hash("invented-legacy-key")],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  expect(await metered(a.token, ra!, "invented-legacy-key")).toEqual(first);
  expect(await jobs(a.id)).toHaveLength(1);
  expect(await held(a.id)).toBe(1);
  expect((await metered(b.token, rb!, "invented-legacy-key")).kind).toBe(
    "queued",
  );
  expect(await jobs(a.id)).toHaveLength(1);
});
