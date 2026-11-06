import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { syntheticLedger } from "../../src/ledger.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { migrate, store } from "../../src/store.ts";
import { studyAllowanceStore } from "../../src/study-allowances.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  catalog = catalogStore(pool),
  counted = practiceSessionStore(pool, { allowance: true }),
  free = practiceSessionStore(pool),
  allowances = studyAllowanceStore(pool, {
    mode: "test",
    enabled: true,
    practiceUnits: true,
  }),
  off = studyAllowanceStore(pool, { mode: "test", enabled: true });
const MOCK = "mock-allowance-test-v1";
const token = () => randomBytes(32).toString("hex");

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs, principals, cohorts, content_versions CASCADE",
  );
});
afterAll(async () => pool.end());

async function member() {
  const value = token();
  await members.create(value, { background: "explorer", goal: "everyday" });
  const session = await members.session(value);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token: value, id: session.learner.id };
}
async function lessons(count: number) {
  const auth = authorizationStore(pool),
    editor = token(),
    reviewer = token(),
    until = new Date(Date.now() + 86400000);
  await auth.provisionStaff(editor, "editor", until);
  await auth.provisionStaff(reviewer, "reviewer", until);
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `SYN-${String(500 + index)}`;
    const draft: DraftContent = {
      id,
      version: 1,
      kind: "lesson",
      origin: "curated",
      title: `Invented source ${id}`,
      body: "Compare only invented examples against this exact source.",
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
    expect(await catalog.submit(editor, id, 1)).toBe(true);
    expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
    expect(await catalog.publish(editor, id, 1)).toBe(true);
    ids.push(id);
  }
  return { ids, retire: (id: string) => catalog.retire(editor, id) };
}
const slot = (contentId: string) => ({
  contentId,
  contentVersion: 1,
  goal: "everyday" as const,
  promptVersion: "practice-v1",
});
const monthStart = (offset = 0) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
  );
};
const instruction = () => ({
  policyVersion: MOCK,
  periodStart: monthStart().toISOString(),
});
async function claim(value: string, key = randomUUID()) {
  const result = await allowances.claim(value, key, instruction());
  if (result.kind !== "ready") throw Error(`Claim failed: ${result.kind}`);
  return result.value;
}
async function balance(id: string) {
  return (
    await pool.query<{
      available: number;
      reserved: number;
      consumed: number;
    }>(
      `SELECT available,reserved,consumed FROM synthetic_entitlement_grants
       WHERE member_id=$1 AND category='mock_sessions' AND expires_at>clock_timestamp()`,
      [id],
    )
  ).rows[0];
}
const count = async (table: string, id: string) =>
  (
    await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE member_id=$1`,
      [id],
    )
  ).rows[0]!.count;
const sessionId = (result: { kind: string; sessionId?: string }) => {
  if (!result.sessionId) throw Error(`Start failed: ${result.kind}`);
  return result.sessionId;
};

it("MOCK-01 a practice claim is deliberate, exact and independent of the study slot", async () => {
  const owner = await member();
  const view = await allowances.member(owner.token);
  expect(view).toMatchObject({
    kind: "ready",
    value: {
      policy: { version: "study-allowance-test-v1" },
      practice: { policy: { version: MOCK, periodLimit: 3 }, claim: null },
    },
  });
  expect(await count("synthetic_entitlement_grants", owner.id)).toBe(0);
  const key = randomUUID();
  const first = await claim(owner.token, key);
  expect(first).toMatchObject({ policyVersion: MOCK, quantity: 3 });
  expect((await claim(owner.token, key)).id).toBe(first.id);
  expect((await claim(owner.token)).id).toBe(first.id);
  const study = await allowances.claim(owner.token, randomUUID(), {
    policyVersion: "study-allowance-test-v1",
    periodStart: monthStart().toISOString(),
  });
  expect(study.kind).toBe("ready");
  expect(await count("study_allowance_claims", owner.id)).toBe(2);
  expect(await balance(owner.id)).toMatchObject({ available: 3, consumed: 0 });
});
it("MOCK-02/03 a new session uses one unit; returning, racing and all 30 turns use no more", async () => {
  const owner = await member(),
    { ids } = await lessons(1);
  await claim(owner.token);
  const raced = await Promise.all(
    Array.from({ length: 4 }, () => counted.start(owner.token, slot(ids[0]!))),
  );
  expect(raced.filter((item) => item.kind === "started")).toHaveLength(1);
  expect(raced.filter((item) => item.kind === "replayed")).toHaveLength(3);
  expect(new Set(raced.map(sessionId)).size).toBe(1);
  expect(await balance(owner.id)).toEqual({
    available: 2,
    reserved: 0,
    consumed: 1,
  });
  const id = sessionId(raced[0]!);
  for (let sequence = 1; sequence <= 15; sequence += 1)
    expect(
      await counted.append(owner.token, id, {
        expectedSequence: sequence,
        response: `Invented response ${sequence}`,
      }),
    ).toBe("saved");
  expect(
    await counted.append(owner.token, id, {
      expectedSequence: 16,
      response: "One too many",
    }),
  ).toBe("full");
  expect((await counted.detail(owner.token, id))?.exchanges).toHaveLength(15);
  expect((await counted.start(owner.token, slot(ids[0]!))).kind).toBe(
    "replayed",
  );
  expect(await balance(owner.id)).toEqual({
    available: 2,
    reserved: 0,
    consumed: 1,
  });
  expect(await count("practice_session_allowance_uses", owner.id)).toBe(1);
});
it("MOCK-04 two different sessions racing for the last unit start exactly one", async () => {
  const owner = await member(),
    { ids } = await lessons(4);
  await claim(owner.token);
  for (const id of ids.slice(0, 2))
    expect((await counted.start(owner.token, slot(id))).kind).toBe("started");
  const raced = await Promise.all(
    ids.slice(2).map((id) => counted.start(owner.token, slot(id))),
  );
  expect(raced.map((item) => item.kind).sort()).toEqual([
    "allowance-needed",
    "started",
  ]);
  expect(await balance(owner.id)).toEqual({
    available: 0,
    reserved: 0,
    consumed: 3,
  });
  expect(await count("private_practice_sessions", owner.id)).toBe(3);
  expect(await count("practice_session_allowance_uses", owner.id)).toBe(3);
});
it("MOCK-05 no claim, none left or last month's units refuse a new session and keep old ones open", async () => {
  const owner = await member(),
    { ids } = await lessons(5);
  const started = sessionId(await free.start(owner.token, slot(ids[0]!)));
  expect(await counted.start(owner.token, slot(ids[1]!))).toEqual({
    kind: "allowance-needed",
  });
  expect(await count("private_practice_sessions", owner.id)).toBe(1);

  // Unused units from last month, created through the same guard a real one meets.
  const start = monthStart(-1),
    end = monthStart();
  const grant = await syntheticLedger(pool).grant(
    owner.id,
    "mock_sessions",
    3,
    `mock-allowance:${owner.id}:${start.toISOString().slice(0, 7)}`,
    { startsAt: start.toISOString(), expiresAt: end.toISOString() },
  );
  await pool.query(
    `INSERT INTO study_allowance_claims(id,member_id,workspace_id,policy_version,category,period_start,period_end,quantity,grant_id,operation_key)
     VALUES($1,$2,$2,$3,'mock_sessions',$4,$5,3,$6,$7)`,
    [randomUUID(), owner.id, MOCK, start, end, grant, randomUUID()],
  );
  expect((await counted.start(owner.token, slot(ids[1]!))).kind).toBe(
    "allowance-needed",
  );

  await claim(owner.token);
  for (const id of ids.slice(1, 4))
    expect((await counted.start(owner.token, slot(id))).kind).toBe("started");
  expect((await counted.start(owner.token, slot(ids[4]!))).kind).toBe(
    "allowance-needed",
  );
  expect((await counted.start(owner.token, slot(ids[0]!))).kind).toBe(
    "replayed",
  );
  expect(
    await counted.append(owner.token, started, {
      expectedSequence: 1,
      response: "Invented response",
    }),
  ).toBe("saved");
});
it("MOCK-06 refused starts cost nothing, and withdrawal neither refunds nor restarts", async () => {
  const owner = await member(),
    { ids, retire } = await lessons(2);
  await claim(owner.token);
  expect(await retire(ids[1]!)).toBeTruthy();
  expect((await counted.start(owner.token, slot(ids[1]!))).kind).toBe(
    "unavailable",
  );
  expect(
    (
      await counted.start(owner.token, {
        ...slot(ids[0]!),
        goal: "work",
      })
    ).kind,
  ).toBe("unavailable");
  expect(await balance(owner.id)).toMatchObject({ available: 3, consumed: 0 });

  const id = sessionId(await counted.start(owner.token, slot(ids[0]!)));
  expect(await counted.withdraw(owner.token, id)).toBe("withdrawn");
  expect((await counted.start(owner.token, slot(ids[0]!))).kind).toBe(
    "withdrawn",
  );
  expect(await balance(owner.id)).toEqual({
    available: 2,
    reserved: 0,
    consumed: 1,
  });
});
it("MOCK-07 with the setting off starts stay free and a practice claim is refused", async () => {
  const owner = await member(),
    { ids } = await lessons(1);
  expect(await off.member(owner.token)).toMatchObject({
    value: { practice: null },
  });
  expect(await off.claim(owner.token, randomUUID(), instruction())).toEqual({
    kind: "denied",
  });
  expect((await free.start(owner.token, slot(ids[0]!))).kind).toBe("started");
  expect(await count("synthetic_entitlement_grants", owner.id)).toBe(0);
  expect(await count("practice_session_allowance_uses", owner.id)).toBe(0);
});
it("MOCK-08 uses are private, exported without references and erased with the account", async () => {
  const owner = await member(),
    other = await member(),
    { ids } = await lessons(1);
  const claimed = await claim(owner.token);
  await claim(other.token);
  const id = sessionId(await counted.start(owner.token, slot(ids[0]!)));
  await counted.start(other.token, slot(ids[0]!));
  expect(await counted.detail(other.token, id)).toBeNull();

  const exported = await memberExportStore(pool).exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Expected an owned export");
  const records = exported.payload.records.practiceSessionAllowanceUses!;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ sessionId: id, claimId: claimed.id });
  expect(records[0]).not.toHaveProperty("reservationId");

  await expect(
    pool.query(
      "DELETE FROM practice_session_allowance_uses WHERE session_id=$1",
      [id],
    ),
  ).rejects.toThrow("retained");
  await expect(
    pool.query(
      "UPDATE practice_session_allowance_uses SET created_at=now() WHERE session_id=$1",
      [id],
    ),
  ).rejects.toThrow("immutable");
  await pool.query("DELETE FROM principals WHERE id=$1", [owner.id]);
  expect(await count("practice_session_allowance_uses", owner.id)).toBe(0);
  expect(await count("study_allowance_claims", owner.id)).toBe(0);
  expect(await count("synthetic_entitlement_grants", owner.id)).toBe(0);
  expect(await count("practice_session_allowance_uses", other.id)).toBe(1);
});
it("MOCK-02 the database refuses a use without the exact consumed unit", async () => {
  const owner = await member(),
    { ids } = await lessons(1);
  const claimed = await claim(owner.token);
  const id = sessionId(await free.start(owner.token, slot(ids[0]!)));
  await expect(
    pool.query(
      `INSERT INTO practice_session_allowance_uses(session_id,member_id,claim_id,reservation_id)
       VALUES($1,$2,$3,$4)`,
      [id, owner.id, claimed.id, randomUUID()],
    ),
  ).rejects.toThrow("Exact practice session allowance unit required");
});
