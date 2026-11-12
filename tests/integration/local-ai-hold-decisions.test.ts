import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { testPool } from "../support/database.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { evidenceStore, type ObjectStorage } from "../../src/evidence.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { localAiConsentStore } from "../../src/local-ai-consent.ts";
import { deterministicRegistry } from "../../src/adapters.ts";
import { jobStore } from "../../src/jobs.ts";
import { localAiHoldInspectionStore } from "../../src/local-ai-hold-inspection.ts";
import {
  localAiHoldDecisionStore,
  type HoldTestDecisionInput,
} from "../../src/local-ai-hold-decisions.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { localAiConsentPage } from "../../src/views.ts";
// #189 HOLDDEC: labelled test outcomes on invented held requests. No provider
// exists; the AI boundary always throws, which is what leaves a request held.
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
let executions = 0;
const local = localAiConsentStore(pool, objects, {
  mode: "test",
  adapter: () => ({
    ...registry.adapter("ai", "test"),
    execute: async () => {
      executions++;
      throw Error("Invented ambiguous outcome");
    },
  }),
});
const evidence = evidenceStore(pool, objects, "invented-hold-decision-secret");
const inspection = localAiHoldInspectionStore(pool, {
  mode: "test",
  enabled: true,
  secret: Buffer.alloc(32, 9),
});
const decisions = localAiHoldDecisionStore(pool, {
  mode: "test",
  enabled: true,
});
const PRIVATE_TEXT = "PRIVATE-SOURCE-MUST-NOT-LEAVE";
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals,cohorts CASCADE");
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
  bytes.clear();
  executions = 0;
});
afterAll(() => pool.end());

async function held(
  options: { metered?: boolean; state?: "held" | "expired" } = {},
) {
  const ownerToken = randomBytes(32).toString("hex"),
    adminToken = randomBytes(32).toString("hex"),
    operatorToken = randomBytes(32).toString("hex"),
    otherOperatorToken = randomBytes(32).toString("hex");
  await db.create(ownerToken, { background: "explorer", goal: "everyday" });
  const owner = await db.session(ownerToken);
  if (owner.kind !== "active") throw Error("Invented owner absent");
  const starts = new Date(Date.now() - 60000),
    expires = new Date(Date.now() + 3600000);
  await auth.provisionStaff(adminToken, "platform_admin", expires);
  const operatorId = await auth.provisionStaff(
    operatorToken,
    "operator",
    expires,
  );
  await auth.provisionStaff(otherOperatorToken, "operator", expires);
  const upload = await evidence.upload(ownerToken, {
    name: "PRIVATE-NAME-MUST-NOT-LEAVE",
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
  if (options.metered)
    await syntheticLedger(pool).grant(
      owner.learner.id,
      "study_requests",
      1,
      randomUUID(),
      { startsAt: starts.toISOString(), expiresAt: expires.toISOString() },
    );
  const queued = await (options.metered ? local.enqueueMetered : local.enqueue)(
    ownerToken,
    permission.receiptId,
    randomUUID(),
  );
  if (queued.kind !== "queued") throw Error("Invented request absent");
  let attemptToken: string | null = null;
  if (options.state === "expired") {
    attemptToken = randomUUID();
    await pool.query(
      "UPDATE adapter_jobs SET status='running',attempt_count=1,attempt_token=$2,lease_until=clock_timestamp()-interval '5 seconds' WHERE id=$1",
      [queued.jobId, attemptToken],
    );
  } else await local.run(ownerToken, queued.jobId);
  const grant = await inspection.grant(
    adminToken,
    queued.jobId,
    operatorId,
    starts,
    expires,
    randomUUID(),
  );
  if (!("grantId" in grant)) throw Error("Expected exact assignment");
  executions = 0;
  return {
    ownerToken,
    ownerId: owner.learner.id,
    adminToken,
    operatorToken,
    operatorId,
    otherOperatorToken,
    jobId: queued.jobId,
    evidenceId: upload.id,
    grantId: grant.grantId,
    attemptToken,
  };
}
const input = (
  overrides: Partial<HoldTestDecisionInput> = {},
): HoldTestDecisionInput => ({
  outcome: "test-executed",
  reason: "matching-test-record",
  sourceReference: "test-record-0001",
  key: randomUUID(),
  ...overrides,
});
async function snapshot(jobId: string) {
  const one = async (sql: string) =>
    (await pool.query(sql, [jobId])).rows.map((r) => r.value);
  return {
    job: await one(
      "SELECT to_jsonb(j)-'local_ai_receipt_id' AS value FROM adapter_jobs j WHERE id=$1",
    ),
    units: await one(
      "SELECT to_jsonb(r) AS value FROM synthetic_entitlement_reservations r JOIN local_ai_test_unit_jobs b ON b.reservation_id=r.id WHERE b.job_id=$1",
    ),
    balances: (
      await pool.query(
        "SELECT to_jsonb(g) AS value FROM synthetic_entitlement_grants g ORDER BY id",
      )
    ).rows.map((r) => r.value),
    settlements: await one(
      "SELECT to_jsonb(s) AS value FROM ai_usage_settlements s WHERE job_id=$1",
    ),
  };
}
const rows = async (jobId: string) =>
  (
    await pool.query(
      "SELECT to_jsonb(d) AS value FROM local_ai_hold_test_decisions d WHERE job_id=$1",
      [jobId],
    )
  ).rows.map((r) => r.value);

it("HOLDDEC-01 an assigned operator records one labelled test outcome on a held request without charging, releasing or retrying it", async () => {
  const f = await held();
  const before = await snapshot(f.jobId);
  expect(await decisions.read(f.operatorToken, f.jobId)).toEqual({
    kind: "ready",
    jobId: f.jobId,
    open: true,
    metered: false,
    decision: null,
  });
  const recorded = await decisions.record(f.operatorToken, f.jobId, input());
  expect(recorded).toMatchObject({
    kind: "applied",
    decision: {
      outcome: "test-executed",
      reason: "matching-test-record",
      sourceKind: "invented-test-record",
      sourceReference: "test-record-0001",
      priorStatus: "needs_reconciliation",
      decidedByReader: true,
    },
  });
  expect(await decisions.read(f.operatorToken, f.jobId)).toMatchObject({
    kind: "ready",
    open: false,
    decision: { outcome: "test-executed" },
  });
  expect(await snapshot(f.jobId)).toEqual(before);
  expect(executions).toBe(0);
  const [row] = await rows(f.jobId);
  expect(row).toMatchObject({
    member_id: f.ownerId,
    grant_id: f.grantId,
    operator_id: f.operatorId,
    source_kind: "invented-test-record",
  });
  expect(JSON.stringify(row)).not.toContain(PRIVATE_TEXT);
});

it("HOLDDEC-02 a repeated request replays, and a changed or second decision conflicts without changing the first", async () => {
  const f = await held();
  const first = input();
  const applied = await decisions.record(f.operatorToken, f.jobId, first);
  expect(applied.kind).toBe("applied");
  expect(await decisions.record(f.operatorToken, f.jobId, first)).toEqual({
    ...applied,
    kind: "replayed",
  });
  expect(
    await decisions.record(
      f.operatorToken,
      f.jobId,
      input({ key: first.key, outcome: "test-not-executed" }),
    ),
  ).toEqual({ kind: "conflict" });
  expect(
    await decisions.record(
      f.operatorToken,
      f.jobId,
      input({ outcome: "test-not-executed" }),
    ),
  ).toEqual({ kind: "conflict" });
  const stored = await rows(f.jobId);
  expect(stored).toHaveLength(1);
  expect(stored[0].outcome).toBe("test-executed");
});

it("HOLDDEC-03 members, unassigned or revoked operators and administrators cannot read or record a decision", async () => {
  const f = await held();
  for (const token of [
    f.ownerToken,
    f.otherOperatorToken,
    f.adminToken,
    randomBytes(32).toString("hex"),
  ]) {
    expect(await decisions.read(token, f.jobId)).toEqual({ kind: "denied" });
    expect(await decisions.record(token, f.jobId, input())).toEqual({
      kind: "denied",
    });
  }
  expect(await decisions.read(f.operatorToken, randomUUID())).toEqual({
    kind: "denied",
  });
  expect((await inspection.revoke(f.adminToken, f.grantId)).kind).toBe(
    "applied",
  );
  expect(await decisions.record(f.operatorToken, f.jobId, input())).toEqual({
    kind: "denied",
  });
  expect(await rows(f.jobId)).toEqual([]);
});

it("HOLDDEC-04 an expired claim is held before its decision, so the late worker cannot complete or fail it", async () => {
  const f = await held({ state: "expired" });
  const recorded = await decisions.record(
    f.operatorToken,
    f.jobId,
    input({ outcome: "test-not-executed" }),
  );
  expect(recorded).toMatchObject({
    kind: "applied",
    decision: { priorStatus: "expired-claim" },
  });
  const jobs = jobStore(pool);
  const late = await jobs.succeed(f.jobId, f.attemptToken!, "late-ref");
  expect(late).toMatchObject({
    status: "needs_reconciliation",
    safeError: "provider_outcome_unknown",
    providerOperationReference: null,
  });
  expect(
    (await jobs.fail(f.jobId, f.attemptToken!, "provider_timeout")).status,
  ).toBe("needs_reconciliation");
  // A fresh claim and the member's own run cannot redispatch it either.
  expect(await jobs.claim(f.jobId)).toBeUndefined();
  await local.run(f.ownerToken, f.jobId);
  expect(executions).toBe(0);
  expect((await rows(f.jobId))[0].outcome).toBe("test-not-executed");
});

it("HOLDDEC-05 the database refuses any later change to a reviewed job or its decision", async () => {
  const f = await held();
  await decisions.record(f.operatorToken, f.jobId, input());
  await expect(
    pool.query(
      "UPDATE adapter_jobs SET status='succeeded',safe_error=NULL WHERE id=$1",
      [f.jobId],
    ),
  ).rejects.toThrow("A reviewed local AI hold cannot change");
  await expect(
    pool.query(
      "UPDATE local_ai_hold_test_decisions SET outcome='test-not-executed' WHERE job_id=$1",
      [f.jobId],
    ),
  ).rejects.toThrow("A reviewed hold decision is immutable");
  await expect(
    pool.query("DELETE FROM local_ai_hold_test_decisions WHERE job_id=$1", [
      f.jobId,
    ]),
  ).rejects.toThrow("A reviewed hold decision requires member erasure");
  await expect(
    pool.query(
      "INSERT INTO local_ai_hold_test_decisions(job_id,member_id,grant_id,operator_id,outcome,reason,source_reference,prior_status,idempotency_key) VALUES($1,$2,$3,$4,'test-executed','matching-test-record','test-direct','needs_reconciliation',$5)",
      [f.jobId, f.ownerId, f.grantId, f.operatorId, randomUUID()],
    ),
  ).rejects.toThrow();
});

it("HOLDDEC-06 concurrent different decisions on one request leave exactly one", async () => {
  const f = await held();
  const results = await Promise.all([
    decisions.record(f.operatorToken, f.jobId, input()),
    decisions.record(
      f.operatorToken,
      f.jobId,
      input({ outcome: "test-not-executed", reason: "operator-test-exercise" }),
    ),
  ]);
  expect(results.map((r) => r.kind).sort()).toEqual(["applied", "conflict"]);
  expect(await rows(f.jobId)).toHaveLength(1);
});

it("HOLDDEC-07 free text, unknown outcomes and non-test references are refused and nothing is stored", async () => {
  const f = await held();
  for (const bad of [
    { sourceReference: PRIVATE_TEXT },
    { sourceReference: "record-0001" },
    { sourceReference: "test-" + "a".repeat(61) },
    { outcome: "provider-confirmed" as never },
    { reason: "looks fine" as never },
    { key: "not-a-uuid" },
  ])
    expect(
      await decisions.record(f.operatorToken, f.jobId, input(bad)),
    ).toEqual({ kind: "invalid" });
  expect(await decisions.read(f.operatorToken, "not-a-uuid")).toEqual({
    kind: "invalid",
  });
  expect(await rows(f.jobId)).toEqual([]);
});

it("HOLDDEC-08 a request that is not held cannot receive a decision", async () => {
  const f = await held({ state: "expired" });
  await pool.query(
    "UPDATE adapter_jobs SET lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1",
    [f.jobId],
  );
  expect(await decisions.read(f.operatorToken, f.jobId)).toMatchObject({
    kind: "ready",
    open: false,
    decision: null,
  });
  expect(await decisions.record(f.operatorToken, f.jobId, input())).toEqual({
    kind: "closed",
  });
  expect(await rows(f.jobId)).toEqual([]);
});

it("HOLDDEC-09 a metered held request keeps its reserved unit after a decision", async () => {
  const f = await held({ metered: true });
  const before = await snapshot(f.jobId);
  expect(before.units[0].state).toBe("reserved");
  expect(await decisions.read(f.operatorToken, f.jobId)).toMatchObject({
    open: true,
    metered: true,
  });
  expect((await decisions.record(f.operatorToken, f.jobId, input())).kind).toBe(
    "applied",
  );
  expect(await snapshot(f.jobId)).toEqual(before);
});

it("HOLDDEC-10 deleting the source keeps the reviewed hold; account erasure removes it", async () => {
  const f = await held();
  await decisions.record(f.operatorToken, f.jobId, input());
  expect(await evidence.remove(f.ownerToken, f.evidenceId)).toBe(true);
  expect(await rows(f.jobId)).toHaveLength(1);
  expect(await decisions.read(f.operatorToken, f.jobId)).toMatchObject({
    kind: "ready",
    decision: { outcome: "test-executed" },
  });
  await evidence.removeWorkspace(f.ownerToken);
  // Pending deletion already withholds the reviewed hold from staff.
  expect((await decisions.read(f.operatorToken, f.jobId)).kind).toBe("denied");
  await db.remove(f.ownerId);
  expect(await rows(f.jobId)).toEqual([]);
  expect(
    (await pool.query("SELECT 1 FROM adapter_jobs WHERE id=$1", [f.jobId]))
      .rowCount,
  ).toBe(0);
});

it("HOLDDEC-11 decisions are unavailable in live mode or when hold inspection is off", async () => {
  const f = await held();
  for (const store of [
    localAiHoldDecisionStore(pool, { mode: "live", enabled: true }),
    localAiHoldDecisionStore(pool, { mode: "test", enabled: false }),
  ]) {
    expect(await store.read(f.operatorToken, f.jobId)).toEqual({
      kind: "unavailable",
    });
    expect(await store.record(f.operatorToken, f.jobId, input())).toEqual({
      kind: "unavailable",
    });
  }
  expect(await rows(f.jobId)).toEqual([]);
});

// HOLDDEC-13..16: the member sees and exports the recorded test outcome on
// their own held request, never who recorded it, under which assignment, with
// which reference or key, and nothing reaches another member.
const exporter = memberExportStore(pool);
const operatorDetails = (f: Awaited<ReturnType<typeof held>>, key: string) => [
  f.operatorId,
  f.grantId,
  key,
  "test-record-0001",
  PRIVATE_TEXT,
];
async function exportedJobs(token: string) {
  const result = await exporter.exportOwned(token);
  if (result.kind !== "ready") throw Error("Expected an export");
  expect(result.payload.version).toBe("local-member-records-v52");
  return result.payload.records.adapterJobs!;
}

it("HOLDDEC-13 the member sees the recorded test outcome on their held request, labelled as not provider-confirmed, without operator details", async () => {
  const f = await held();
  const [before] = await local.list(f.ownerToken);
  expect(before!.jobs).toEqual([
    expect.not.objectContaining({ testOutcome: expect.anything() }),
  ]);
  const choice = input();
  const recorded = await decisions.record(f.operatorToken, f.jobId, choice);
  if (recorded.kind !== "applied") throw Error("Expected a decision");
  const listed = await local.list(f.ownerToken);
  expect(listed[0]!.jobs).toEqual([
    expect.objectContaining({
      id: f.jobId,
      status: "needs_reconciliation",
      testOutcome: {
        outcome: "test-executed",
        reason: "matching-test-record",
        decidedAt: new Date(recorded.decision.decidedAt),
      },
    }),
  ]);
  const html = localAiConsentPage(listed, "csrf-invented");
  expect(html).toContain("A test outcome was recorded for this held request");
  expect(html).toContain("it ran");
  expect(html).toContain("No AI provider confirmed it");
  expect(html).toContain("the request stays held");
  expect(html).not.toContain(`/evidence/local-ai/${f.jobId}/run`);
  for (const value of operatorDetails(f, choice.key)) {
    expect(JSON.stringify(listed)).not.toContain(value);
    expect(html).not.toContain(value);
  }
});

it("HOLDDEC-14 the outcome stays visible after the member deletes the source", async () => {
  const f = await held();
  const choice = input({
    outcome: "test-not-executed",
    reason: "operator-test-exercise",
  });
  expect((await decisions.record(f.operatorToken, f.jobId, choice)).kind).toBe(
    "applied",
  );
  expect(await evidence.remove(f.ownerToken, f.evidenceId)).toBe(true);
  const listed = await local.list(f.ownerToken);
  expect(listed).toEqual([
    expect.objectContaining({
      sourceDeleted: true,
      jobs: [
        expect.objectContaining({
          id: f.jobId,
          testOutcome: expect.objectContaining({
            outcome: "test-not-executed",
            reason: "operator-test-exercise",
          }),
        }),
      ],
    }),
  ]);
  const html = localAiConsentPage(listed, "csrf-invented");
  expect(html).toContain("it did not run");
  expect(html).toContain("recorded as an operator test exercise");
  for (const value of operatorDetails(f, choice.key))
    expect(html).not.toContain(value);
});

it("HOLDDEC-15 the member's export includes the test outcome without operator details; an undecided hold exports none", async () => {
  const f = await held();
  const choice = input();
  const recorded = await decisions.record(f.operatorToken, f.jobId, choice);
  if (recorded.kind !== "applied") throw Error("Expected a decision");
  const [row] = await exportedJobs(f.ownerToken);
  expect(row).toMatchObject({
    id: f.jobId,
    status: "needs_reconciliation",
    holdTestOutcome: {
      outcome: "test-executed",
      reason: "matching-test-record",
      decidedAt: recorded.decision.decidedAt,
      label: "TEST OUTCOME · NOT PROVIDER-CONFIRMED · STILL HELD",
    },
  });
  expect(Object.keys(row!.holdTestOutcome as object).sort()).toEqual([
    "decidedAt",
    "label",
    "outcome",
    "reason",
  ]);
  for (const value of operatorDetails(f, choice.key))
    expect(JSON.stringify(row)).not.toContain(value);
  const undecided = await held();
  expect(await exportedJobs(undecided.ownerToken)).toEqual([
    expect.objectContaining({ id: undecided.jobId, holdTestOutcome: null }),
  ]);
});

it("HOLDDEC-16 another member sees and exports nothing of the outcome, even with their own held request", async () => {
  const f = await held(),
    other = await held();
  expect((await decisions.record(f.operatorToken, f.jobId, input())).kind).toBe(
    "applied",
  );
  const listed = await local.list(other.ownerToken);
  const exportedRows = await exportedJobs(other.ownerToken);
  for (const text of [
    JSON.stringify(listed),
    localAiConsentPage(listed, "csrf-invented"),
    JSON.stringify(exportedRows),
  ]) {
    expect(text).not.toContain(f.jobId);
    expect(text).not.toContain("test-executed");
    expect(text).not.toContain("test outcome was recorded");
  }
  expect(exportedRows).toEqual([
    expect.objectContaining({ id: other.jobId, holdTestOutcome: null }),
  ]);
});
