import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { localAiHoldInspectionStore } from "../../src/local-ai-hold-inspection.ts";
const pool = testPool(),
  db = store(pool),
  auth = authorizationStore(pool);
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
// Only the external AI boundary is stubbed. No provider is ever called.
const execute = vi.fn();
const local = localAiConsentStore(pool, objects, {
  mode: "test",
  adapter: () => ({ ...registry.adapter("ai", "test"), execute }),
});
const evidence = evidenceStore(pool, objects, "invented-unmetered-hold-secret");
const inspection = localAiHoldInspectionStore(pool, {
  mode: "test",
  enabled: true,
  secret: Buffer.alloc(32, 7),
});
const PRIVATE_NAME = "PRIVATE-NAME-MUST-NOT-LEAVE";
const PRIVATE_TEXT = "PRIVATE-SOURCE-MUST-NOT-LEAVE";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  bytes.clear();
  execute.mockReset();
  execute.mockRejectedValue(Error("Invented ambiguous outcome"));
});
afterAll(() => pool.end());

type State = "held" | "expired" | "running" | "failed" | "pending";
async function unmetered(state: State = "held") {
  const ownerToken = randomBytes(32).toString("hex"),
    adminToken = randomBytes(32).toString("hex"),
    operatorToken = randomBytes(32).toString("hex"),
    otherOperatorToken = randomBytes(32).toString("hex");
  await db.create(ownerToken, { background: "explorer", goal: "everyday" });
  const owner = await db.session(ownerToken);
  if (owner.kind !== "active") throw Error("Invented owner absent");
  const starts = new Date(Date.now() - 60000),
    expires = new Date(Date.now() + 3600000);
  const adminId = await auth.provisionStaff(
    adminToken,
    "platform_admin",
    expires,
  );
  const operatorId = await auth.provisionStaff(
    operatorToken,
    "operator",
    expires,
  );
  await auth.provisionStaff(otherOperatorToken, "operator", expires);
  const upload = await evidence.upload(ownerToken, {
    name: PRIVATE_NAME,
    mediaType: "text/plain",
    data: Buffer.from(PRIVATE_TEXT),
    consent: {
      rightsConfirmed: true,
      privateReview: true,
      communityPublication: false,
    },
  });
  if (upload.kind !== "created") throw Error("Invented upload absent");
  await evidence.transitionQuarantine(upload.id, "clean");
  const permission = await local.grant(ownerToken, upload.id);
  if (permission.kind !== "granted") throw Error("Invented permission absent");
  const queued = await local.enqueue(
    ownerToken,
    permission.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Invented request absent");
  if (state === "held") await local.run(ownerToken, queued.jobId);
  else if (state !== "pending")
    await pool.query(
      "UPDATE adapter_jobs SET status=$2,attempt_count=1,attempt_token=$3,lease_until=$4::timestamptz,safe_error=$5 WHERE id=$1",
      [
        queued.jobId,
        state === "failed" ? "failed" : "running",
        state === "failed" ? null : randomUUID(),
        state === "failed"
          ? null
          : new Date(Date.now() + (state === "expired" ? -5000 : 300000)),
        state === "failed" ? "invalid_provider_response" : null,
      ],
    );
  execute.mockClear();
  return {
    ownerToken,
    ownerId: owner.learner.id,
    adminToken,
    adminId,
    operatorToken,
    operatorId,
    otherOperatorToken,
    jobId: queued.jobId,
    evidenceId: upload.id,
    receiptId: permission.receiptId,
    starts,
    expires,
  };
}
type Fixture = Awaited<ReturnType<typeof unmetered>>;
const assign = (f: Fixture, key: string = randomUUID()) =>
  inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    key,
  );
async function assigned(f: Fixture) {
  const grant = await assign(f);
  if (!("grantId" in grant)) throw Error("Expected exact assignment");
  return grant.grantId;
}
const row = async (jobId: string) =>
  (
    await pool.query(
      "SELECT status,safe_error,attempt_token,lease_until,local_ai_receipt_id,attempt_count FROM adapter_jobs WHERE id=$1",
      [jobId],
    )
  ).rows[0];
const count = async (sql: string, ...values: unknown[]) =>
  (await pool.query(`SELECT count(*)::int AS c FROM ${sql}`, values)).rows[0].c;
function expectNoPrivateValue(f: Fixture, encoded: string) {
  for (const value of [
    f.ownerId,
    f.evidenceId,
    f.receiptId,
    f.adminId,
    f.operatorId,
    f.ownerToken,
    PRIVATE_NAME,
    PRIVATE_TEXT,
    "local-ai:",
  ])
    expect(encoded).not.toContain(value);
}

it("STAFFHOLD-01 an assigned operator reads only safe metadata of an unmetered hold, and reading changes nothing", async () => {
  const f = await unmetered();
  const before = await pool.query(
    "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
    [f.jobId],
  );
  expect(await row(f.jobId)).toMatchObject({
    status: "needs_reconciliation",
    safe_error: "provider_outcome_unknown",
  });
  expect((await assign(f)).kind).toBe("applied");
  const listed = await inspection.list(f.operatorToken);
  if (listed.kind !== "ready") throw Error("Expected assigned worklist");
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]).toEqual({
    jobId: f.jobId,
    state: "needs-reconciliation",
    status: "needs_reconciliation",
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
    leaseUntil: null,
    unitState: null,
    policy: null,
    promptTemplateVersion: "local-simulation-v1",
    modelContractVersion: "deterministic-local-v1",
  });
  const detail = await inspection.detail(f.operatorToken, f.jobId);
  expect(detail).toEqual({ kind: "ready", value: listed.items[0] });
  expectNoPrivateValue(f, JSON.stringify({ listed, detail }));
  expect(
    (
      await pool.query(
        "SELECT to_jsonb(j) AS value FROM adapter_jobs j WHERE id=$1",
        [f.jobId],
      )
    ).rows,
  ).toEqual(before.rows);
  expect(execute).not.toHaveBeenCalled();
});
it("STAFFHOLD-01 an expired claim on an unmetered request reads as an unconfirmed hold without being rewritten", async () => {
  const f = await unmetered("expired");
  expect((await assign(f)).kind).toBe("applied");
  const listed = await inspection.list(f.operatorToken);
  if (listed.kind !== "ready") throw Error("Expected assigned worklist");
  expect(listed.items[0]).toMatchObject({
    state: "expired-claim",
    status: "running",
    unitState: null,
  });
  expect((await row(f.jobId)).status).toBe("running");
});
it("STAFFHOLD-02 no other person can read an unmetered hold, and a self-assignment is refused", async () => {
  const f = await unmetered();
  expect((await inspection.list(f.operatorToken)).kind).toBe("denied");
  await assigned(f);
  for (const actor of [
    f.otherOperatorToken,
    f.adminToken,
    f.ownerToken,
    randomBytes(32).toString("hex"),
  ]) {
    expect((await inspection.list(actor)).kind).toBe("denied");
    expect((await inspection.detail(actor, f.jobId)).kind).toBe("denied");
    expect((await inspection.detail(actor, randomUUID())).kind).toBe("denied");
  }
  expect(
    (
      await inspection.grant(
        f.adminToken,
        f.jobId,
        f.adminId,
        f.starts,
        f.expires,
        randomUUID(),
      )
    ).kind,
  ).toBe("denied");
  for (const actor of [f.ownerToken, f.operatorToken])
    expect(
      (
        await inspection.grant(
          actor,
          f.jobId,
          f.operatorId,
          f.starts,
          f.expires,
          randomUUID(),
        )
      ).kind,
    ).toBe("denied");
});
it.each(["pending", "running", "failed"] as const)(
  "STAFFHOLD-03 a %s unmetered request cannot be assigned for inspection",
  async (state) => {
    const f = await unmetered(state);
    expect((await assign(f)).kind).toBe("denied");
    expect(await count("local_ai_hold_inspection_grants")).toBe(0);
    expect(await count("local_ai_hold_inspection_events")).toBe(0);
  },
);
it("STAFFHOLD-03 a closed or unrelated job cannot be assigned for inspection", async () => {
  const closed = await unmetered("pending");
  await local.withdraw(closed.ownerToken, closed.receiptId);
  expect((await row(closed.jobId)).status).toBe("exhausted");
  expect((await assign(closed)).kind).toBe("denied");
  const unrelated = await unmetered();
  await pool.query(
    "UPDATE adapter_jobs SET local_ai_receipt_id=NULL,operation='another-operation' WHERE id=$1",
    [unrelated.jobId],
  );
  expect((await assign(unrelated)).kind).toBe("denied");
  expect(await count("local_ai_hold_inspection_grants")).toBe(0);
});
it("STAFFHOLD-04 revocation, role change, session expiry and pause all end access to an unmetered hold", async () => {
  const f = await unmetered();
  const grantId = await assigned(f);
  await pool.query(
    "UPDATE staff_profiles SET role='coach' WHERE principal_id=$1",
    [f.operatorId],
  );
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
  await pool.query(
    "UPDATE staff_profiles SET role='operator' WHERE principal_id=$1",
    [f.operatorId],
  );
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "ready",
  );
  const paused = localAiHoldInspectionStore(pool, {
    mode: "test",
    enabled: false,
  });
  expect(await paused.detail(f.operatorToken, f.jobId)).toEqual({
    kind: "unavailable",
  });
  const live = localAiHoldInspectionStore(pool, {
    mode: "live",
    enabled: true,
  });
  expect(await live.detail(f.operatorToken, f.jobId)).toEqual({
    kind: "unavailable",
  });
  expect((await paused.revoke(f.adminToken, grantId)).kind).toBe("applied");
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
  const second = await unmetered();
  await assigned(second);
  await pool.query(
    "UPDATE principals SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [second.operatorId],
  );
  expect((await inspection.list(second.operatorToken)).kind).toBe("denied");
});
it.each(["held", "expired", "running", "failed"] as const)(
  "STAFFHOLD-05 deleting the source of a started %s unmetered request keeps a source-free hold",
  async (state) => {
    const f = await unmetered(state);
    expect(await evidence.remove(f.ownerToken, f.evidenceId)).toBe(true);
    expect(bytes.size).toBe(0);
    expect(await count("evidence_objects WHERE id=$1", f.evidenceId)).toBe(0);
    expect(await count("local_ai_receipts WHERE id=$1", f.receiptId)).toBe(0);
    expect(await row(f.jobId)).toEqual({
      status: "needs_reconciliation",
      safe_error: "provider_outcome_unknown",
      attempt_token: null,
      lease_until: null,
      local_ai_receipt_id: null,
      attempt_count: 1,
    });
    expect(await local.run(f.ownerToken, f.jobId)).toEqual({ kind: "denied" });
    expect((await row(f.jobId)).status).toBe("needs_reconciliation");
    expect(execute).not.toHaveBeenCalled();
    // A grant can still be made afterwards, and it cannot reach the source.
    await assigned(f);
    const detail = await inspection.detail(f.operatorToken, f.jobId);
    expect(detail).toMatchObject({
      kind: "ready",
      value: { state: "needs-reconciliation", unitState: null },
    });
    expectNoPrivateValue(f, JSON.stringify(detail));
  },
);
it("STAFFHOLD-05 a grant made before deletion keeps working after the source has gone", async () => {
  const f = await unmetered();
  await assigned(f);
  expect(await evidence.remove(f.ownerToken, f.evidenceId)).toBe(true);
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "ready",
  );
  expect(await count("local_ai_hold_inspection_grants")).toBe(1);
});
it("STAFFHOLD-06 deleting the source still removes a never-started request", async () => {
  const f = await unmetered("pending");
  expect(await evidence.remove(f.ownerToken, f.evidenceId)).toBe(true);
  expect(await row(f.jobId)).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
});
it("STAFFHOLD-06 deleting the source still removes a succeeded request", async () => {
  const f = await unmetered("pending");
  execute.mockImplementation((...args: [string, { text: string }]) =>
    registry.adapter("ai", "test").execute(...args),
  );
  expect(await local.run(f.ownerToken, f.jobId)).toMatchObject({
    status: "succeeded",
  });
  expect(await evidence.remove(f.ownerToken, f.evidenceId)).toBe(true);
  expect(await row(f.jobId)).toBeUndefined();
});
it("STAFFHOLD-06 deleting the source still removes a closed request", async () => {
  const f = await unmetered("pending");
  await local.withdraw(f.ownerToken, f.receiptId);
  expect(await evidence.remove(f.ownerToken, f.evidenceId)).toBe(true);
  expect(await row(f.jobId)).toBeUndefined();
});
it("STAFFHOLD-07 a grant's audit trail never blocks deleting a source whose request finished late", async () => {
  const f = await unmetered("expired");
  await assigned(f);
  await pool.query(
    "UPDATE adapter_jobs SET status='succeeded',attempt_token=NULL,lease_until=NULL,provider_operation_reference='local_invented' WHERE id=$1",
    [f.jobId],
  );
  expect(await evidence.remove(f.ownerToken, f.evidenceId)).toBe(true);
  expect(await count("evidence_objects WHERE id=$1", f.evidenceId)).toBe(0);
  expect(await row(f.jobId)).toMatchObject({
    status: "succeeded",
    local_ai_receipt_id: null,
  });
  expect(await inspection.detail(f.operatorToken, f.jobId)).toMatchObject({
    kind: "ready",
    value: { state: "not-unconfirmed", status: "succeeded" },
  });
});
it("STAFFHOLD-08 the member still sees a hold after deleting its source, with no source details and no way to run it", async () => {
  const f = await unmetered();
  const other = await unmetered();
  await evidence.remove(f.ownerToken, f.evidenceId);
  const choices = await local.list(f.ownerToken);
  expect(choices).toHaveLength(1);
  expect(choices[0]).toMatchObject({
    sourceDeleted: true,
    retired: true,
    receiptId: null,
    jobs: [{ id: f.jobId, status: "needs_reconciliation" }],
  });
  expectNoPrivateValue(f, JSON.stringify(choices));
  // Another member's hold never appears, and an empty account shows nothing.
  expect(JSON.stringify(await local.list(other.ownerToken))).not.toContain(
    f.jobId,
  );
  const removed = await unmetered("pending");
  await evidence.remove(removed.ownerToken, removed.evidenceId);
  expect(await local.list(removed.ownerToken)).toEqual([]);
  expect(await local.list(randomBytes(32).toString("hex"))).toEqual([]);
});
it("STAFFHOLD-09 full account erasure removes the hold, grant and events, and leaves other members alone", async () => {
  const f = await unmetered(),
    other = await unmetered();
  await assigned(f);
  await assigned(other);
  await evidence.remove(f.ownerToken, f.evidenceId);
  await evidence.removeWorkspace(f.ownerToken);
  // Pending deletion already withholds the retained hold from staff.
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
  await db.remove(f.ownerId);
  expect(await row(f.jobId)).toBeUndefined();
  expect(
    await count(
      "local_ai_hold_inspection_grants WHERE member_id=$1",
      f.ownerId,
    ),
  ).toBe(0);
  expect(
    await count(
      "local_ai_hold_inspection_events WHERE member_id=$1",
      f.ownerId,
    ),
  ).toBe(0);
  expect((await inspection.detail(f.operatorToken, f.jobId)).kind).toBe(
    "denied",
  );
  expect((await inspection.detail(other.operatorToken, other.jobId)).kind).toBe(
    "ready",
  );
});
it("STAFFHOLD-09 erasing an account with an undeleted held source removes everything", async () => {
  const f = await unmetered();
  await assigned(f);
  await evidence.removeWorkspace(f.ownerToken);
  await db.remove(f.ownerId);
  expect(await row(f.jobId)).toBeUndefined();
  expect(await count("local_ai_hold_inspection_grants")).toBe(0);
  expect(await count("local_ai_hold_inspection_events")).toBe(0);
});
