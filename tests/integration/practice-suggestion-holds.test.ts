import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { localAiHoldInspectionStore } from "../../src/local-ai-hold-inspection.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { migrate, store } from "../../src/store.ts";
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
  return { adminToken, operatorToken, operatorId, jobId, starts, expires };
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
