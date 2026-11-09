import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { memberExportStore } from "../../src/member-export.ts";
import type { PracticeSuggestionProvider } from "../../src/practice-ai-suggestions.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { migrate, store } from "../../src/store.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";
import { setTestCeiling } from "../support/ai-test-ceiling.ts";
import {
  aiCostPoints,
  aiInputTokens,
  estimateAiRequest,
} from "../../src/ai-budget-policy.ts";

// #200 PRACTICE-AI: simulated suggestions on saved practice pairs, from the
// local deterministic test provider, on real PostgreSQL. Invented data only.
const pool = testPool(),
  members = store(pool),
  catalog = catalogStore(pool),
  practice = practiceSessionStore(pool, { suggestions: { mode: "test" } });
const LABEL = "Simulated AI suggestion, not reviewed by a person.";
const NOTICE =
  "This interview practice doesn't predict hiring, interview results or competence.";
const token = () => randomBytes(32).toString("hex");
const RESPONSE =
  "I would ask the assistant for a short invented shopping list and check each item against the lesson.";

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs, principals, cohorts, content_versions CASCADE",
  );
  await pool.query(
    "INSERT INTO local_ai_control(singleton,paused) VALUES(true,false) ON CONFLICT(singleton) DO UPDATE SET paused=false",
  );
});
afterEach(async () => {
  await pool.query("UPDATE local_ai_control SET paused=false");
});
afterAll(async () => {
  // Leave the shared test ceiling usable for later files.
  await setTestCeiling(pool, { ceiling: 100000, committed: 0 });
  await pool.end();
});

async function member() {
  const value = token();
  await members.create(value, { background: "explorer", goal: "everyday" });
  const session = await members.session(value);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token: value, id: session.learner.id };
}
async function lesson() {
  const auth = authorizationStore(pool),
    editor = token(),
    reviewer = token(),
    until = new Date(Date.now() + 86400000);
  await auth.provisionStaff(editor, "editor", until);
  await auth.provisionStaff(reviewer, "reviewer", until);
  const draft: DraftContent = {
    id: "SYN-620",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented suggestion source",
    body: "Check each invented list item against this exact source before relying on it.",
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
  async function publish(version: number) {
    expect(await catalog.createDraft(editor, { ...draft, version })).toBe(true);
    expect(await catalog.submit(editor, draft.id, version)).toBe(true);
    expect(await catalog.approve(reviewer, draft.id, version, true)).toBe(true);
    expect(await catalog.publish(editor, draft.id, version)).toBe(true);
  }
  await publish(1);
  return { publish, retire: () => catalog.retire(editor, draft.id) };
}
async function saved(
  owner: { token: string },
  promptVersion = "practice-v1",
  responses = [RESPONSE],
  store = practice,
) {
  const started = await store.start(owner.token, {
    contentId: "SYN-620",
    contentVersion: 1,
    goal: "everyday",
    promptVersion,
  });
  if (!("sessionId" in started)) throw Error(`Start failed: ${started.kind}`);
  for (const [index, response] of responses.entries())
    expect(
      await store.append(owner.token, started.sessionId, {
        expectedSequence: index + 1,
        response,
      }),
    ).toBe("saved");
  return started.sessionId;
}
const jobs = async (memberId: string) =>
  (
    await pool.query<{
      status: string;
      safe_error: string | null;
      operation: string;
      attempt_count: number;
    }>(
      "SELECT status,safe_error,operation,attempt_count FROM adapter_jobs WHERE member_id=$1 ORDER BY created_at",
      [memberId],
    )
  ).rows;
const suggestions = async (memberId: string) =>
  (
    await pool.query<{ state: string; suggestion: string | null }>(
      "SELECT state,suggestion FROM practice_ai_suggestions WHERE member_id=$1 ORDER BY sequence",
      [memberId],
    )
  ).rows;
function counting(provider: PracticeSuggestionProvider) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async suggest(input: Parameters<PracticeSuggestionProvider["suggest"]>[0]) {
      calls++;
      return provider.suggest(input);
    },
  };
}

it("PRACTICE-AI-01 a member asks for one grounded simulated suggestion on a saved pair, and reading creates nothing", async () => {
  await lesson();
  const owner = await member();
  const id = await saved(owner);
  const before = (await practice.detail(owner.token, id))!;
  expect(before.suggestions).toBe("available");
  expect(before.exchanges[0]!.suggestion).toBeNull();
  expect(await jobs(owner.id)).toEqual([]);

  expect(await practice.suggest?.(owner.token, id, 1)).toBe("ready");
  const after = (await practice.detail(owner.token, id))!;
  const suggestion = after.exchanges[0]!.suggestion!;
  expect(suggestion.state).toBe("ready");
  expect(suggestion.text).toMatch(new RegExp(`^${LABEL}`));
  expect(suggestion.text).toContain(`“${RESPONSE}”`);
  expect(suggestion.text).toContain("SYN-620 v1");
  expect(suggestion.text).toContain("uncertain");
  expect(suggestion.text).toContain("It gives no score");
  expect(suggestion.text).not.toMatch(/[0-9]+\s*(\/|%|out of)/);
  expect(await jobs(owner.id)).toEqual([
    {
      status: "succeeded",
      safe_error: null,
      operation: "practice-suggestion-local-v1",
      attempt_count: 1,
    },
  ]);
});

it("PRACTICE-AI-01 interview practice suggestions also say they predict nothing", async () => {
  await lesson();
  const owner = await member();
  const id = await saved(owner, "interview-practice-v1");
  expect(await practice.suggest?.(owner.token, id, 1)).toBe("ready");
  const text = (await practice.detail(owner.token, id))!.exchanges[0]!
    .suggestion!.text!;
  expect(text).toContain(NOTICE);
});

it("PRACTICE-AI-02 ungrounded, scored or malformed provider output is rejected whole and never retried", async () => {
  await lesson();
  const bad: unknown[] = [
    {
      text: `${LABEL} You wrote: “something I never said here”. Compare that with SYN-620 v1. This is uncertain. It gives no score and is not an assessment.`,
      reference: "test_a",
    },
    {
      text: `${LABEL} You wrote: “${RESPONSE}”. Compare that with SYN-620 v2. This is uncertain. It gives no score and is not an assessment.`,
      reference: "test_b",
    },
    {
      text: `${LABEL} You wrote: “${RESPONSE}”. Compare that with SYN-620 v1. This is uncertain. Score: 8 of ten. It gives no score and is not an assessment.`,
      reference: "test_c",
    },
    {
      text: `${LABEL} You wrote: “${RESPONSE}”. Compare that with SYN-620 v1. It gives no score and is not an assessment.`,
      reference: "test_d",
    },
    "not an object",
    {
      text: `${LABEL} You wrote: “${RESPONSE}”.`,
      reference: "bad reference with spaces",
    },
  ];
  for (const value of bad) {
    const owner = await member();
    const id = await saved(owner);
    const provider = counting({ suggest: async () => value });
    const store = practiceSessionStore(pool, {
      suggestions: { mode: "test", provider },
    });
    expect(await store.suggest?.(owner.token, id, 1)).toBe("rejected");
    expect(await store.suggest?.(owner.token, id, 1)).toBe("replayed");
    expect(provider.calls).toBe(1);
    expect(await suggestions(owner.id)).toEqual([
      { state: "rejected", suggestion: null },
    ]);
    expect(await jobs(owner.id)).toMatchObject([
      { status: "exhausted", safe_error: "invalid_provider_response" },
    ]);
    const pair = (await store.detail(owner.token, id))!.exchanges[0]!;
    expect(pair.suggestion).toMatchObject({ state: "rejected", text: null });
  }
});

it("PRACTICE-AI-03 a provider error leaves an unknown outcome that holds its place and is never retried", async () => {
  await lesson();
  const owner = await member();
  const id = await saved(owner);
  const provider = counting({
    suggest: async () => {
      throw new Error("invented provider fault");
    },
  });
  const store = practiceSessionStore(pool, {
    suggestions: { mode: "test", provider },
  });
  expect(await store.suggest?.(owner.token, id, 1)).toBe("unknown");
  expect(await store.suggest?.(owner.token, id, 1)).toBe("replayed");
  expect(provider.calls).toBe(1);
  expect(await jobs(owner.id)).toMatchObject([
    { status: "needs_reconciliation", safe_error: "provider_outcome_unknown" },
  ]);
  expect(
    (await store.detail(owner.token, id))!.exchanges[0]!.suggestion,
  ).toMatchObject({ state: "unknown", text: null });
});

it("PRACTICE-AI-04 repeated and concurrent requests for one pair make one provider call", async () => {
  await lesson();
  const owner = await member();
  const id = await saved(owner, "practice-v1", [
    RESPONSE,
    `${RESPONSE} Again.`,
  ]);
  const provider = counting(
    (
      await import("../../src/practice-ai-suggestions.ts")
    ).deterministicPracticeSuggestionProvider("test"),
  );
  const store = practiceSessionStore(pool, {
    suggestions: { mode: "test", provider },
  });
  const raced = await Promise.all(
    Array.from({ length: 4 }, () => store.suggest?.(owner.token, id, 1)),
  );
  expect(raced.filter((item) => item === "ready")).toHaveLength(1);
  expect(raced.filter((item) => item === "replayed")).toHaveLength(3);
  expect(provider.calls).toBe(1);
  expect(await store.suggest?.(owner.token, id, 2)).toBe("ready");
  expect(await suggestions(owner.id)).toHaveLength(2);
  expect(await store.suggest?.(owner.token, id, 3)).toBe("unavailable");
});

it("PRACTICE-AI-05 paused simulations, the 3-request limit and a retired source request nothing", async () => {
  const content = await lesson();
  const owner = await member();
  const id = await saved(owner, "practice-v1", [
    "One invented answer here.",
    "Two invented answer here.",
    "Three invented answer here.",
    "Four invented answer here.",
  ]);
  const provider = counting({
    suggest: async () => {
      throw new Error("held");
    },
  });
  const holding = practiceSessionStore(pool, {
    suggestions: { mode: "test", provider },
  });

  await pool.query("UPDATE local_ai_control SET paused=true");
  expect((await holding.detail(owner.token, id))!.suggestions).toBe("paused");
  expect(await holding.suggest?.(owner.token, id, 1)).toBe("paused");
  await pool.query("UPDATE local_ai_control SET paused=false");

  // Three held outcomes fill the member's #190 limit of unfinished AI requests.
  for (const sequence of [1, 2, 3])
    expect(await holding.suggest?.(owner.token, id, sequence)).toBe("unknown");
  expect(await holding.suggest?.(owner.token, id, 4)).toBe("limit");
  expect(provider.calls).toBe(3);
  expect(await jobs(owner.id)).toHaveLength(3);

  const other = await member();
  const fresh = await saved(other);
  await content.retire();
  expect(await practice.suggest?.(other.token, fresh, 1)).toBe("unavailable");
  expect(await jobs(other.id)).toEqual([]);
});

it("PRACTICE-AI-06 other members cannot request or read a suggestion, and export, withdrawal and erasure cover it", async () => {
  await lesson();
  const owner = await member();
  const id = await saved(owner);
  const other = await member();
  expect(await practice.suggest?.(other.token, id, 1)).toBe("unavailable");
  expect(await practice.detail(other.token, id)).toBeNull();
  expect(await jobs(other.id)).toEqual([]);

  expect(await practice.suggest?.(owner.token, id, 1)).toBe("ready");
  const exported = await memberExportStore(pool).exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Export unavailable");
  expect(exported.payload.version).toBe("local-member-records-v43");
  const rows = exported.payload.records.practiceAiSuggestions!;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    sessionId: id,
    sequence: 1,
    state: "ready",
    label: "SIMULATED · LOCAL TEST PROVIDER · NOT REVIEWED · NO SCORE",
  });
  expect(rows[0]!.suggestion).toContain(RESPONSE);
  expect(JSON.stringify(rows)).not.toMatch(/fingerprint|test_[a-f0-9]{24}/);
  const otherExport = await memberExportStore(pool).exportOwned(other.token);
  if (otherExport.kind !== "ready") throw Error("Export unavailable");
  expect(otherExport.payload.records.practiceAiSuggestions).toEqual([]);

  expect(await practice.withdraw(owner.token, id)).toBe("withdrawn");
  expect(await suggestions(owner.id)).toEqual([]);
  expect(await practice.suggest?.(owner.token, id, 1)).toBe("withdrawn");

  const erased = await member();
  const kept = await saved(erased);
  expect(await practice.suggest?.(erased.token, kept, 1)).toBe("ready");
  await pool.query("DELETE FROM principals WHERE id=$1", [erased.id]);
  expect(await suggestions(erased.id)).toEqual([]);
  expect(await jobs(erased.id)).toEqual([]);
});

it("PRACTICE-AI-06 a pair withdrawn while the provider answers keeps nothing", async () => {
  await lesson();
  const owner = await member();
  const id = await saved(owner);
  const real = (
    await import("../../src/practice-ai-suggestions.ts")
  ).deterministicPracticeSuggestionProvider("test");
  const store = practiceSessionStore(pool, {
    suggestions: {
      mode: "test",
      provider: {
        async suggest(input) {
          expect(await practice.withdraw(owner.token, id)).toBe("withdrawn");
          return real.suggest(input);
        },
      },
    },
  });
  expect(await store.suggest?.(owner.token, id, 1)).toBe("withdrawn");
  expect(await suggestions(owner.id)).toEqual([]);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM private_practice_exchanges WHERE session_id=$1",
        [id],
      )
    ).rows[0]!.n,
  ).toBe(0);
});

it("PRACTICE-AI-07 a store without suggestions requests nothing, and the table refuses a forged or rewritten row", async () => {
  await lesson();
  const owner = await member();
  const plain = practiceSessionStore(pool);
  const id = await saved(owner, "practice-v1", [RESPONSE], plain);
  expect((await plain.detail(owner.token, id))!.suggestions).toBeUndefined();
  expect(await plain.suggest?.(owner.token, id, 1)).toBe("unavailable");
  expect(await jobs(owner.id)).toEqual([]);

  expect(await practice.suggest?.(owner.token, id, 1)).toBe("ready");
  await expect(
    pool.query(
      "UPDATE practice_ai_suggestions SET suggestion='rewritten' WHERE member_id=$1",
      [owner.id],
    ),
  ).rejects.toThrow(/immutable/);
  const other = await member();
  await expect(
    pool.query(
      `INSERT INTO practice_ai_suggestions(session_id,sequence,member_id,job_id)
       SELECT session_id,sequence,$2,job_id FROM practice_ai_suggestions WHERE member_id=$1`,
      [owner.id, other.id],
    ),
  ).rejects.toThrow();
});

// #188 metering: practice suggestions count against the platform test
// spending ceiling like every other simulated AI request. Points are the
// published invented test rates; no money and no member units are involved.
const spend = async (memberId: string) =>
  (
    await pool.query<{
      estimate: number | null;
      estimateRate: string | null;
      actual: number | null;
      commitment: string | null;
      committedPoints: number | null;
      settledPoints: number | null;
    }>(
      `SELECT e.cost_points AS estimate,e.rate_version AS "estimateRate",s.cost_points AS actual,
        c.state AS commitment,c.estimated_points AS "committedPoints",c.actual_points AS "settledPoints"
       FROM adapter_jobs j LEFT JOIN ai_usage_estimates e ON e.job_id=j.id
       LEFT JOIN ai_usage_settlements s ON s.job_id=j.id
       LEFT JOIN ai_spending_commitments c ON c.job_id=j.id
       WHERE j.member_id=$1 ORDER BY j.created_at`,
      [memberId],
    )
  ).rows;
const committed = async () =>
  Number(
    (
      await pool.query<{ committed: string }>(
        "SELECT committed_points AS committed FROM ai_test_spending_ceiling WHERE singleton",
      )
    ).rows[0]!.committed,
  );
async function expected(sessionId: string, sequence = 1) {
  const pair = (
    await pool.query<{ response: string; excerpt: string }>(
      "SELECT response,source_excerpt AS excerpt FROM private_practice_exchanges WHERE session_id=$1 AND sequence=$2",
      [sessionId, sequence],
    )
  ).rows[0]!;
  return estimateAiRequest(
    Buffer.byteLength(pair.response) + Buffer.byteLength(pair.excerpt),
  );
}

it("PRACTICE-AI-08 a suggestion commits its labelled estimate before the provider call and settles at reported simulated usage", async () => {
  await setTestCeiling(pool, { ceiling: 100000, committed: 0 });
  await lesson();
  const owner = await member();
  const id = await saved(owner);
  const estimate = await expected(id);
  let during: Awaited<ReturnType<typeof spend>> = [];
  let duringCommitted = -1;
  const real = (
    await import("../../src/practice-ai-suggestions.ts")
  ).deterministicPracticeSuggestionProvider("test");
  const store = practiceSessionStore(pool, {
    suggestions: {
      mode: "test",
      provider: {
        async suggest(input) {
          during = await spend(owner.id);
          duringCommitted = await committed();
          return real.suggest(input);
        },
      },
    },
  });
  expect(await store.suggest?.(owner.token, id, 1)).toBe("ready");
  // Committed before the call, at the stored estimate.
  expect(during).toEqual([
    {
      estimate: estimate.costPoints,
      estimateRate: "simulated-rates-v1",
      actual: null,
      commitment: "committed",
      committedPoints: estimate.costPoints,
      settledPoints: null,
    },
  ]);
  expect(duringCommitted).toBe(estimate.costPoints);
  // Settled at the usage the simulated provider reported.
  const text = (await store.detail(owner.token, id))!.exchanges[0]!.suggestion!
    .text!;
  const actual = aiCostPoints({
    inputTokens: estimate.inputTokens,
    outputTokens: aiInputTokens(Buffer.byteLength(text)),
  });
  expect(await spend(owner.id)).toEqual([
    {
      estimate: estimate.costPoints,
      estimateRate: "simulated-rates-v1",
      actual,
      commitment: "settled",
      committedPoints: estimate.costPoints,
      settledPoints: actual,
    },
  ]);
  expect(await committed()).toBe(actual);
  // A replay spends nothing more.
  expect(await store.suggest?.(owner.token, id, 1)).toBe("replayed");
  expect(await committed()).toBe(actual);
  // The member's own export shows the labelled figures.
  const exported = await memberExportStore(pool).exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Export unavailable");
  expect(exported.payload.records.aiUsage).toMatchObject([
    {
      estimatedCostPoints: estimate.costPoints,
      actualCostPoints: actual,
      label: "ESTIMATE · SIMULATED · NO MONEY CHARGED",
    },
  ]);
});

it("PRACTICE-AI-09 a ceiling without room requests nothing, and two pairs racing for the last room make one call", async () => {
  await lesson();
  const owner = await member();
  const id = await saved(owner, "practice-v1", [RESPONSE, `${RESPONSE} Too.`]);
  const first = await expected(id, 1);
  const provider = counting(
    (
      await import("../../src/practice-ai-suggestions.ts")
    ).deterministicPracticeSuggestionProvider("test"),
  );
  const store = practiceSessionStore(pool, {
    suggestions: { mode: "test", provider },
  });
  await setTestCeiling(pool, {
    ceiling: 5000 + first.costPoints - 1,
    committed: 5000,
  });
  expect(await store.suggest?.(owner.token, id, 1)).toBe("ceiling");
  expect(provider.calls).toBe(0);
  expect(await jobs(owner.id)).toEqual([]);
  expect(await suggestions(owner.id)).toEqual([]);
  expect(await committed()).toBe(5000);
  const pair = (await store.detail(owner.token, id))!.exchanges[0]!;
  expect(pair.suggestion).toBeNull();

  // Room for exactly one of the two estimates.
  await setTestCeiling(pool, {
    ceiling: 5000 + first.costPoints,
    committed: 5000,
  });
  const raced = await Promise.all([
    store.suggest?.(owner.token, id, 1),
    store.suggest?.(owner.token, id, 2),
  ]);
  expect(raced.filter((item) => item === "ready")).toHaveLength(1);
  expect(raced.filter((item) => item === "ceiling")).toHaveLength(1);
  expect(provider.calls).toBe(1);
  expect(await jobs(owner.id)).toHaveLength(1);
  expect(await committed()).toBeLessThanOrEqual(5000 + first.costPoints + 200);
});

it("PRACTICE-AI-10 unknown or unreported spend stays committed at its estimate, and withdrawal and erasure keep recorded spend", async () => {
  await setTestCeiling(pool, { ceiling: 100000, committed: 0 });
  await lesson();
  const owner = await member();
  const id = await saved(owner, "practice-v1", [
    RESPONSE,
    `${RESPONSE} Second.`,
    `${RESPONSE} Third.`,
  ]);
  const estimates = [
    await expected(id, 1),
    await expected(id, 2),
    await expected(id, 3),
  ];
  const real = (
    await import("../../src/practice-ai-suggestions.ts")
  ).deterministicPracticeSuggestionProvider("test");
  const answers: ((
    input: Parameters<PracticeSuggestionProvider["suggest"]>[0],
  ) => Promise<unknown>)[] = [
    // 1: an error after the call may have spent: held, estimate kept.
    async () => {
      throw new Error("invented provider fault");
    },
    // 2: a valid answer without usage: shown, but its estimate stays committed.
    async (input) => {
      const { usage: _usage, ...rest } = (await real.suggest(input)) as {
        usage: unknown;
      };
      return rest;
    },
    // 3: an invalid answer with usage: rejected, settled at that usage.
    async () => ({
      text: "Score 10",
      reference: "test_x",
      usage: { inputTokens: 5, outputTokens: 1 },
    }),
  ];
  let call = 0;
  const store = practiceSessionStore(pool, {
    suggestions: {
      mode: "test",
      provider: { suggest: (input) => answers[call++]!(input) },
    },
  });
  expect(await store.suggest?.(owner.token, id, 1)).toBe("unknown");
  expect(await store.suggest?.(owner.token, id, 2)).toBe("ready");
  expect(await store.suggest?.(owner.token, id, 3)).toBe("rejected");
  const rejectedPoints = aiCostPoints({ inputTokens: 5, outputTokens: 1 });
  expect(await spend(owner.id)).toMatchObject([
    {
      commitment: "committed",
      actual: null,
      committedPoints: estimates[0]!.costPoints,
    },
    {
      commitment: "committed",
      actual: null,
      committedPoints: estimates[1]!.costPoints,
    },
    {
      commitment: "settled",
      actual: rejectedPoints,
      settledPoints: rejectedPoints,
    },
  ]);
  const total =
    estimates[0]!.costPoints + estimates[1]!.costPoints + rejectedPoints;
  expect(await committed()).toBe(total);

  // Withdrawal removes the pairs and suggestions but not recorded spend.
  expect(await store.withdraw(owner.token, id)).toBe("withdrawn");
  expect(await suggestions(owner.id)).toEqual([]);
  expect(await committed()).toBe(total);
  // Erasure removes the member's figures; the platform counter keeps the spend.
  await pool.query("DELETE FROM principals WHERE id=$1", [owner.id]);
  expect(await spend(owner.id)).toEqual([]);
  expect(await committed()).toBe(total);
});

it("PRACTICE-AI-10 the database refuses forged practice estimates, commitments and settlements", async () => {
  await setTestCeiling(pool, { ceiling: 100000, committed: 0 });
  await lesson();
  const owner = await member();
  const id = await saved(owner, "practice-v1", [
    RESPONSE,
    `${RESPONSE} Again.`,
  ]);
  expect(await practice.suggest?.(owner.token, id, 1)).toBe("ready");
  const job = (
    await pool.query<{ id: string }>(
      "SELECT id FROM adapter_jobs WHERE member_id=$1",
      [owner.id],
    )
  ).rows[0]!.id;
  // The finished request takes no second estimate, commitment or settlement.
  await expect(
    pool.query(
      "INSERT INTO ai_spending_commitments(job_id,attempt,estimated_points,state) VALUES($1,2,1,'committed')",
      [job],
    ),
  ).rejects.toThrow(/claimed metered request/);
  await expect(
    pool.query("DELETE FROM ai_usage_settlements WHERE job_id=$1", [job]),
  ).rejects.toThrow(/member erasure/);
  // A running practice-like job with no requested suggestion cannot be metered.
  const forged = (
    await pool.query<{ id: string }>(
      `INSERT INTO adapter_jobs(id,adapter,mode,operation,idempotency_key,request_fingerprint,status,attempt_count,max_attempts,
        attempt_token,lease_until,member_id)
       VALUES(gen_random_uuid(),'ai','test','practice-suggestion-local-v1','forged-practice-key',repeat('a',64),'running',1,1,
        gen_random_uuid(),clock_timestamp()+interval '5 minutes',$1) RETURNING id`,
      [owner.id],
    )
  ).rows[0]!.id;
  await expect(
    pool.query(
      "INSERT INTO ai_usage_estimates(job_id,member_id,rate_version,model_version,input_tokens,output_tokens,cost_points) VALUES($1,$2,'simulated-rates-v1','simulated-model-v1',1,1,1)",
      [forged, owner.id],
    ),
  ).rejects.toThrow(/new metered request/);
});
