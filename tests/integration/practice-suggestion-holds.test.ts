import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { localAiHoldInspectionStore } from "../../src/local-ai-hold-inspection.ts";
import {
  localAiHoldDecisionStore,
  type HoldTestDecisionInput,
} from "../../src/local-ai-hold-decisions.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { migrate, store } from "../../src/store.ts";
import { practiceSessionPage } from "../../src/views.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

// #189 PRACTICE-HOLD: a practice suggestion whose outcome is unknown (#200)
// reaches the same exact, content-free hold inspection as sample requests.
const pool = testPool(),
  members = store(pool),
  auth = authorizationStore(pool),
  catalog = catalogStore(pool);
const inspection = localAiHoldInspectionStore(pool, {
  mode: "test",
  enabled: true,
  secret: Buffer.alloc(32, 9),
});
const decisions = localAiHoldDecisionStore(pool, {
  mode: "test",
  enabled: true,
});
const exporter = memberExportStore(pool);
const RESPONSE = "PRIVATE-PRACTICE-WORDS-MUST-NOT-LEAVE in an invented answer.";
const token = () => randomBytes(32).toString("hex");
const failing = practiceSessionStore(pool, {
  suggestions: {
    mode: "test",
    provider: {
      suggest: async () => {
        throw Error("Invented ambiguous outcome");
      },
    },
  },
});

beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs, principals, cohorts, content_versions CASCADE",
  );
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
});
afterAll(() => pool.end());

async function held() {
  const editor = token(),
    reviewer = token(),
    adminToken = token(),
    operatorToken = token(),
    ownerToken = token();
  const starts = new Date(Date.now() - 60000),
    expires = new Date(Date.now() + 3600000);
  await auth.provisionStaff(editor, "editor", expires);
  await auth.provisionStaff(reviewer, "reviewer", expires);
  await auth.provisionStaff(adminToken, "platform_admin", expires);
  const operatorId = await auth.provisionStaff(
    operatorToken,
    "operator",
    expires,
  );
  const draft: DraftContent = {
    id: "SYN-640",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented hold source",
    body: "Check each invented detail against this exact source.",
    owner: "Synthetic editor",
    sources: "Original synthetic work",
    rights: "Owned synthetic work",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, "SYN-640", 1)).toBe(true);
  expect(await catalog.approve(reviewer, "SYN-640", 1, true)).toBe(true);
  expect(await catalog.publish(editor, "SYN-640", 1)).toBe(true);
  await members.create(ownerToken, {
    background: "explorer",
    goal: "everyday",
  });
  const started = await failing.start(ownerToken, {
    contentId: "SYN-640",
    contentVersion: 1,
    goal: "everyday",
    promptVersion: "practice-v1",
  });
  if (!("sessionId" in started)) throw Error("Invented session absent");
  expect(
    await failing.append(ownerToken, started.sessionId, {
      expectedSequence: 1,
      response: RESPONSE,
    }),
  ).toBe("saved");
  expect(await failing.suggest!(ownerToken, started.sessionId, 1)).toBe(
    "unknown",
  );
  const jobId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM adapter_jobs WHERE operation='practice-suggestion-local-v1'",
    )
  ).rows[0]!.id;
  return {
    adminToken,
    operatorToken,
    operatorId,
    ownerToken,
    sessionId: started.sessionId,
    jobId,
    starts,
    expires,
  };
}

it("PRACTICE-HOLD-01 an administrator assigns a held practice suggestion and the operator sees it without content", async () => {
  const f = await held();
  const grant = await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  expect(grant.kind).toBe("applied");
  const listed = await inspection.list(f.operatorToken);
  if (listed.kind !== "ready") throw Error("Expected assigned worklist");
  expect(listed.items).toEqual([
    expect.objectContaining({
      jobId: f.jobId,
      status: "needs_reconciliation",
      unitState: null,
      policy: null,
      promptTemplateVersion: "practice-suggestion-v1",
      modelContractVersion: "deterministic-local-v1",
    }),
  ]);
  expect(JSON.stringify(listed)).not.toContain("PRIVATE-PRACTICE-WORDS");
  const detail = await inspection.detail(f.operatorToken, f.jobId);
  expect(detail).toEqual({ kind: "ready", value: listed.items[0] });
});

// #189 PRACTICE-HOLD-02..04: a labelled TEST outcome for a held practice
// suggestion. It is never a provider's confirmation and moves nothing.
const outcome = (
  value: Partial<HoldTestDecisionInput> = {},
): HoldTestDecisionInput => ({
  outcome: "test-not-executed",
  reason: "operator-test-exercise",
  sourceReference: "test-practice-hold-record",
  key: randomUUID(),
  ...value,
});
async function assigned() {
  const f = await held();
  const grant = await inspection.grant(
    f.adminToken,
    f.jobId,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  if (grant.kind !== "applied") throw Error("Expected an assignment");
  return { ...f, grantId: grant.grantId };
}
const heldState = async (jobId: string) =>
  (
    await pool.query<{
      status: string;
      attempts: number;
      suggestion: string;
      commitment: string | null;
      points: number | null;
      settled: boolean;
      jobs: number;
    }>(
      `SELECT j.status,j.attempt_count AS attempts,g.state AS suggestion,c.state AS commitment,
        c.estimated_points AS points,
        EXISTS(SELECT 1 FROM ai_usage_settlements s WHERE s.job_id=j.id) AS settled,
        (SELECT count(*)::int FROM adapter_jobs WHERE member_id=j.member_id) AS jobs
       FROM adapter_jobs j JOIN practice_ai_suggestions g ON g.job_id=j.id
       LEFT JOIN ai_spending_commitments c ON c.job_id=j.id WHERE j.id=$1`,
      [jobId],
    )
  ).rows[0];

it("PRACTICE-HOLD-02 an assigned operator records one test outcome on a held practice suggestion; it moves nothing", async () => {
  const f = await assigned();
  const before = await heldState(f.jobId);
  expect(before).toMatchObject({
    status: "needs_reconciliation",
    suggestion: "requested",
  });
  expect(await decisions.read(f.operatorToken, f.jobId)).toEqual({
    kind: "ready",
    jobId: f.jobId,
    open: true,
    metered: false,
    decision: null,
  });
  const choice = outcome();
  const recorded = await decisions.record(f.operatorToken, f.jobId, choice);
  expect(recorded).toEqual({
    kind: "applied",
    decision: expect.objectContaining({
      outcome: "test-not-executed",
      reason: "operator-test-exercise",
      sourceKind: "invented-test-record",
      priorStatus: "needs_reconciliation",
      decidedByReader: true,
    }),
  });
  if (recorded.kind !== "applied") throw Error("Expected a decision");
  expect(await decisions.record(f.operatorToken, f.jobId, choice)).toEqual({
    kind: "replayed",
    decision: recorded.decision,
  });
  expect(
    await decisions.record(f.operatorToken, f.jobId, {
      ...choice,
      outcome: "test-executed",
    }),
  ).toEqual({ kind: "conflict" });
  expect(await decisions.record(f.operatorToken, f.jobId, outcome())).toEqual({
    kind: "conflict",
  });
  // Still held, still counted on the ceiling, never settled or retried.
  expect(await heldState(f.jobId)).toEqual(before);
  await expect(
    pool.query(
      "UPDATE adapter_jobs SET status='succeeded',safe_error=NULL WHERE id=$1",
      [f.jobId],
    ),
  ).rejects.toThrow(/reviewed local AI hold cannot change/);
});

it("PRACTICE-HOLD-03 the owner's practice page and export show the test outcome without operator details; another member sees nothing", async () => {
  const f = await assigned();
  const plain = await failing.detail(f.ownerToken, f.sessionId);
  expect(plain!.exchanges[0]!.suggestion).toEqual(
    expect.objectContaining({ state: "unknown", testOutcome: null }),
  );
  const choice = outcome({ reason: "matching-test-record" });
  const recorded = await decisions.record(f.operatorToken, f.jobId, choice);
  if (recorded.kind !== "applied") throw Error("Expected a decision");
  const detail = await failing.detail(f.ownerToken, f.sessionId);
  expect(detail!.exchanges[0]!.suggestion).toEqual({
    state: "unknown",
    text: null,
    requestedAt: expect.any(Date),
    testOutcome: {
      outcome: "test-not-executed",
      reason: "matching-test-record",
      decidedAt: new Date(recorded.decision.decidedAt),
    },
  });
  const html = practiceSessionPage(detail!, "csrf-invented");
  expect(html).toContain("data-practice-suggestion-test-outcome");
  expect(html).toContain("it did not run");
  expect(html).toContain("matched to an invented test record");
  expect(html).toContain("No AI provider confirmed it");
  const exported = await exporter.exportOwned(f.ownerToken);
  if (exported.kind !== "ready") throw Error("Expected an export");
  const row = exported.payload.records.adapterJobs!.find(
    (job) => job.id === f.jobId,
  );
  expect(row).toMatchObject({
    status: "needs_reconciliation",
    holdTestOutcome: {
      outcome: "test-not-executed",
      reason: "matching-test-record",
      decidedAt: recorded.decision.decidedAt,
      label: "TEST OUTCOME · NOT PROVIDER-CONFIRMED · STILL HELD",
    },
  });
  for (const hidden of [
    f.operatorId,
    f.grantId,
    choice.key,
    choice.sourceReference,
  ]) {
    expect(html).not.toContain(hidden);
    expect(JSON.stringify(exported.payload)).not.toContain(hidden);
  }
  const stranger = token();
  await members.create(stranger, { background: "explorer", goal: "everyday" });
  expect(await failing.detail(stranger, f.sessionId)).toBeNull();
  const theirs = await exporter.exportOwned(stranger);
  if (theirs.kind !== "ready") throw Error("Expected an export");
  expect(JSON.stringify(theirs.payload)).not.toContain(f.jobId);
});

it("PRACTICE-HOLD-04 a finished suggestion takes no outcome, an unassigned operator is denied, and the member cannot record one", async () => {
  const f = await assigned();
  const other = token();
  await auth.provisionStaff(other, "operator", f.expires);
  expect(await decisions.read(other, f.jobId)).toEqual({ kind: "denied" });
  expect(await decisions.record(other, f.jobId, outcome())).toEqual({
    kind: "denied",
  });
  expect(await decisions.record(f.ownerToken, f.jobId, outcome())).toEqual({
    kind: "denied",
  });
  // A suggestion that finished normally is not held, so it is closed.
  const ok = practiceSessionStore(pool, { suggestions: { mode: "test" } });
  expect(
    await ok.append(f.ownerToken, f.sessionId, {
      expectedSequence: 2,
      response: "A second invented answer that checks one more detail.",
    }),
  ).toBe("saved");
  expect(await ok.suggest!(f.ownerToken, f.sessionId, 2)).toBe("ready");
  const ready = (
    await pool.query<{ id: string }>(
      "SELECT job_id AS id FROM practice_ai_suggestions WHERE session_id=$1 AND sequence=2",
      [f.sessionId],
    )
  ).rows[0]!.id;
  const grant = await inspection.grant(
    f.adminToken,
    ready,
    f.operatorId,
    f.starts,
    f.expires,
    randomUUID(),
  );
  if (grant.kind === "applied") {
    expect(await decisions.record(f.operatorToken, ready, outcome())).toEqual({
      kind: "closed",
    });
  } else expect(grant.kind).toBe("denied");
  expect(
    (
      await pool.query(
        "SELECT 1 FROM local_ai_hold_test_decisions WHERE job_id=$1",
        [ready],
      )
    ).rowCount,
  ).toBe(0);
});
