import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { hash, migrate, store } from "../../src/store.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { jobStore, requestFingerprint } from "../../src/jobs.ts";
import { BACKGROUNDS, type Background } from "../../src/content.ts";

// #187 AC3/AC4: losing authorization just after a retry is claimed never hides
// an earlier attempt that reached the AI step, and every background gets the
// same permission check. Invented text only; the AI boundary is stubbed.
const pool = testPool(),
  db = store(pool);
const bytes = new Map<string, Buffer>();
const objects: ObjectStorage = {
  put: async (key, value) => {
    bytes.set(key, value);
  },
  get: async (key) => {
    const value = bytes.get(key);
    if (!value) throw Error("Invented bytes absent");
    return value;
  },
  remove: async (key) => {
    bytes.delete(key);
  },
};
const registry = deterministicRegistry({}, "test");
const execute = vi.fn(registry.adapter("ai", "test").execute);
const service = (
  connect: typeof pool = pool,
  adapter = () => ({ ...registry.adapter("ai", "test"), execute }),
) => localAiConsentStore(connect, objects, { mode: "test", adapter });
const local = service();
const evidence = evidenceStore(pool, objects, "invented-retry-hold-secret");
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  bytes.clear();
  execute.mockReset();
  execute.mockImplementation(registry.adapter("ai", "test").execute);
});
afterAll(() => pool.end());

async function queued(background: Background = "explorer") {
  const token = randomBytes(32).toString("hex");
  await db.create(token, { background, goal: "everyday" });
  const session = await db.session(token);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  const uploaded = await evidence.upload(token, {
    name: "Invented.txt",
    mediaType: "text/plain",
    data: Buffer.from(`Invented retry source ${randomUUID()}`),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (uploaded.kind !== "created") throw Error("Invented upload failed");
  await evidence.transitionQuarantine(uploaded.id, "clean");
  const permission = await local.grant(token, uploaded.id);
  if (permission.kind !== "granted") throw Error("No invented permission");
  const pending = await local.enqueue(
    token,
    permission.receiptId,
    randomUUID(),
  );
  if (pending.kind !== "queued") throw Error("No invented request");
  return {
    token,
    id: session.learner.id,
    evidenceId: uploaded.id,
    receiptId: permission.receiptId,
    jobId: pending.jobId,
  };
}

/** A first attempt that reached the AI step and came back unusable. */
async function failedOnce() {
  const own = await queued();
  execute.mockResolvedValueOnce({ unusable: "invented" } as never);
  expect(await local.run(own.token, own.jobId)).toMatchObject({
    status: "failed",
  });
  expect(execute).toHaveBeenCalledTimes(1);
  execute.mockClear();
  return own;
}

/** Signs the member out after `run` commits its claim, before it executes. */
function signedOutAfterClaim(memberId: string) {
  let connections = 0;
  return {
    async connect() {
      if (++connections === 2)
        await pool.query(
          "UPDATE principals SET revoked_at=clock_timestamp() WHERE id=$1",
          [memberId],
        );
      return pool.connect();
    },
  } as unknown as typeof pool;
}

const job = async (id: string) =>
  (
    await pool.query(
      "SELECT status,safe_error,attempt_count,attempt_token,lease_until FROM adapter_jobs WHERE id=$1",
      [id],
    )
  ).rows[0];

it("AIHOLD-08 a retry whose member is signed out just after its claim is held, because an earlier attempt reached the AI step", async () => {
  const own = await failedOnce();
  const run = service(signedOutAfterClaim(own.id)).run(own.token, own.jobId);
  expect(await run).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
  expect(await job(own.jobId)).toEqual({
    status: "needs_reconciliation",
    safe_error: "provider_outcome_unknown",
    attempt_count: 2,
    attempt_token: null,
    lease_until: null,
  });
});

it("AIHOLD-09 a request that never started still closes when its member is signed out just after the claim", async () => {
  const own = await queued();
  const run = service(signedOutAfterClaim(own.id)).run(own.token, own.jobId);
  expect(await run).toEqual({ kind: "denied" });
  expect(execute).not.toHaveBeenCalled();
  expect(await job(own.jobId)).toEqual({
    status: "exhausted",
    safe_error: "provider_unavailable",
    attempt_count: 1,
    attempt_token: null,
    lease_until: null,
  });
});

it("AIHOLD-10 a retry refused by a wrong-mode AI boundary is held, and a first attempt still closes", async () => {
  const forged = vi.fn();
  const wrongMode = service(pool, () => ({
    kind: "ai",
    mode: "live",
    execute: forged,
  }));
  const retried = await failedOnce();
  expect(await wrongMode.run(retried.token, retried.jobId)).toEqual({
    kind: "denied",
  });
  expect(await job(retried.jobId)).toMatchObject({
    status: "needs_reconciliation",
    safe_error: "provider_outcome_unknown",
    attempt_count: 2,
    attempt_token: null,
  });
  const first = await queued();
  expect(await wrongMode.run(first.token, first.jobId)).toEqual({
    kind: "denied",
  });
  expect(await job(first.jobId)).toMatchObject({
    status: "exhausted",
    safe_error: "provider_unavailable",
    attempt_count: 1,
  });
  expect(forged).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it("AIHOLD-08 a held retry stays held: running it again calls nothing", async () => {
  const own = await failedOnce();
  await service(signedOutAfterClaim(own.id)).run(own.token, own.jobId);
  const fresh = randomBytes(32).toString("hex");
  await pool.query(
    "UPDATE principals SET revoked_at=NULL,token_hash=$2 WHERE id=$1",
    [own.id, hash(fresh)],
  );
  expect(await local.run(fresh, own.jobId)).toMatchObject({
    status: "needs_reconciliation",
  });
  expect(execute).not.toHaveBeenCalled();
});

it.each(Object.keys(BACKGROUNDS) as Background[])(
  "AIHOLD-11 a %s learner is refused without exact-source permission and runs once with it",
  async (background) => {
    const own = await queued(background);
    await expect(
      jobStore(pool).enqueueForMember(
        own.token,
        "ai",
        "test",
        "summarize",
        `without-permission-${background}`,
        requestFingerprint({ invented: "private source" }),
        3,
        { promptTemplateVersion: "local-v1", modelContractVersion: "local-v1" },
      ),
    ).rejects.toThrow();
    expect(await local.withdraw(own.token, own.receiptId)).toBe(true);
    expect(await local.run(own.token, own.jobId)).toEqual({ kind: "denied" });
    expect(await local.enqueue(own.token, own.receiptId, "again")).toEqual({
      kind: "denied",
    });
    expect(execute).not.toHaveBeenCalled();
    const permission = await local.grant(own.token, own.evidenceId);
    if (permission.kind !== "granted") throw Error("No renewed permission");
    const pending = await local.enqueue(
      own.token,
      permission.receiptId,
      randomUUID(),
    );
    if (pending.kind !== "queued") throw Error("No renewed request");
    expect(await local.run(own.token, pending.jobId)).toMatchObject({
      kind: "completed",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  },
);
