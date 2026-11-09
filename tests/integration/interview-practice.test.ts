import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { practiceSessionStore } from "../../src/practice-sessions.ts";
import { migrate, store } from "../../src/store.ts";
import { studyAllowanceStore } from "../../src/study-allowances.ts";
import { authorizationStore } from "../support/administrator-fixture.ts";
import { testPool } from "../support/database.ts";

// Optional interview practice (#200 AC1) on real PostgreSQL, invented data only.
const pool = testPool(),
  members = store(pool),
  catalog = catalogStore(pool),
  practice = practiceSessionStore(pool),
  counted = practiceSessionStore(pool, { allowance: true }),
  allowances = studyAllowanceStore(pool, {
    mode: "test",
    enabled: true,
    practiceUnits: true,
  });
const INTERVIEW = "interview-practice-v1";
const NOTICE =
  "This interview practice doesn't predict hiring, interview results or competence.";
const token = () => randomBytes(32).toString("hex");

beforeAll(async () => migrate(pool));
beforeEach(async () => {
  await pool.query(
    "TRUNCATE adapter_jobs, principals, cohorts, content_versions CASCADE",
  );
});
afterAll(async () => pool.end());

type Goal = "everyday" | "work" | "build";
async function member(goal: Goal = "everyday") {
  const value = token();
  await members.create(value, {
    background:
      goal === "everyday"
        ? "explorer"
        : goal === "work"
          ? "professional"
          : "technical",
    goal,
  });
  const session = await members.session(value);
  if (session.kind !== "active") throw Error("Invented member unavailable");
  return { token: value, id: session.learner.id };
}
async function staff() {
  const auth = authorizationStore(pool),
    editor = token(),
    reviewer = token(),
    until = new Date(Date.now() + 86400000);
  await auth.provisionStaff(editor, "editor", until);
  await auth.provisionStaff(reviewer, "reviewer", until);
  const draft: DraftContent = {
    id: "SYN-610",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented interview source",
    body: "Check each invented claim against this exact source before answering.",
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
  async function publish(version: number, body = draft.body) {
    expect(await catalog.createDraft(editor, { ...draft, version, body })).toBe(
      true,
    );
    expect(await catalog.submit(editor, draft.id, version)).toBe(true);
    expect(await catalog.approve(reviewer, draft.id, version, true)).toBe(true);
    expect(await catalog.publish(editor, draft.id, version)).toBe(true);
  }
  await publish(1);
  return {
    editor,
    reviewer,
    publish,
    retire: () => catalog.retire(editor, draft.id),
  };
}
const slot = (goal: Goal = "everyday", promptVersion = INTERVIEW) => ({
  contentId: "SYN-610",
  contentVersion: 1,
  goal,
  promptVersion,
});
const sessionId = (result: { kind: string; sessionId?: string }) => {
  if (!result.sessionId) throw Error(`Start failed: ${result.kind}`);
  return result.sessionId;
};
const sessions = async (memberId: string) =>
  (
    await pool.query<{ prompt_version: string }>(
      "SELECT prompt_version FROM private_practice_sessions WHERE member_id=$1 ORDER BY prompt_version",
      [memberId],
    )
  ).rows.map((row) => row.prompt_version);

it("INTERVIEW-01/02 every goal sees optional interview practice and reading it creates nothing", async () => {
  await staff();
  for (const goal of ["everyday", "work", "build"] as const) {
    const owner = await member(goal);
    const source = (await practice.source(owner.token, "SYN-610"))!;
    expect(source).toMatchObject({
      goal,
      promptVersion: "practice-v1",
      interview: { promptVersion: INTERVIEW },
    });
    expect(source.interview.prompt).toContain("invented interview question");
    expect(source.interview.prompt).not.toMatch(/job title|employer|career/i);
    expect(await sessions(owner.id)).toEqual([]);
  }
});
it("INTERVIEW-04 interview practice is its own pinned session beside ordinary practice", async () => {
  await staff();
  const owner = await member();
  const ordinary = sessionId(
    await practice.start(owner.token, slot("everyday", "practice-v1")),
  );
  const raced = await Promise.all(
    Array.from({ length: 3 }, () => practice.start(owner.token, slot())),
  );
  expect(raced.map((item) => item.kind).sort()).toEqual([
    "replayed",
    "replayed",
    "started",
  ]);
  const interview = sessionId(raced[0]!);
  expect(new Set(raced.map(sessionId))).toEqual(new Set([interview]));
  expect(interview).not.toBe(ordinary);
  expect(await sessions(owner.id)).toEqual([INTERVIEW, "practice-v1"]);
  for (const promptVersion of ["interview-practice-v2", "retained-unknown"])
    expect(
      await practice.start(owner.token, slot("everyday", promptVersion)),
    ).toEqual({ kind: "unavailable" });
  expect(await practice.start(owner.token, slot("work"))).toEqual({
    kind: "unavailable",
  });
  expect(await sessions(owner.id)).toEqual([INTERVIEW, "practice-v1"]);
});
it("INTERVIEW-03/05 comparisons predict nothing, the 30-turn cap holds and a changed source freezes it", async () => {
  const f = await staff();
  const owner = await member();
  const id = sessionId(await practice.start(owner.token, slot()));
  for (let sequence = 1; sequence < 15; sequence += 1)
    expect(
      await practice.append(owner.token, id, {
        expectedSequence: sequence,
        response: `Invented answer ${sequence}`,
      }),
    ).toBe("saved");
  const last = await Promise.all(
    ["Final A", "Final B"].map((response) =>
      practice.append(owner.token, id, { expectedSequence: 15, response }),
    ),
  );
  expect(last.sort()).toEqual(["conflict", "saved"]);
  expect(
    await practice.append(owner.token, id, {
      expectedSequence: 16,
      response: "One too many",
    }),
  ).toBe("full");
  const detail = (await practice.detail(owner.token, id))!;
  expect(detail).toMatchObject({
    promptVersion: INTERVIEW,
    availability: "full",
  });
  expect(detail.exchanges).toHaveLength(15);
  for (const pair of detail.exchanges) {
    expect(pair.comparison).toContain(NOTICE);
    expect(pair.comparison).not.toMatch(/\bscore\b|rating/i);
  }
  const rows = await pool.query(
    "SELECT count(*)::int AS n FROM private_practice_exchanges WHERE session_id=$1",
    [id],
  );
  expect(rows.rows[0].n).toBe(15);

  const fresh = sessionId(await practice.start((await member()).token, slot()));
  expect(fresh).not.toBe(id);
  const second = await member();
  const open = sessionId(await practice.start(second.token, slot()));
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [second.id]);
  expect(
    await practice.append(second.token, open, {
      expectedSequence: 1,
      response: "After a goal change",
    }),
  ).toBe("unavailable");
  await pool.query("UPDATE learners SET goal='everyday' WHERE id=$1", [
    second.id,
  ]);
  await f.publish(2, "A replacement invented source.");
  expect(
    await practice.append(second.token, open, {
      expectedSequence: 1,
      response: "After replacement",
    }),
  ).toBe("unavailable");
  expect(await practice.detail(second.token, open)).toMatchObject({
    contentVersion: 1,
    availability: "source-unavailable",
  });
});
it("INTERVIEW-06 a new interview session uses one test unit and returning uses none", async () => {
  await staff();
  const owner = await member();
  expect(await counted.start(owner.token, slot())).toEqual({
    kind: "allowance-needed",
  });
  const now = new Date();
  const claimed = await allowances.claim(owner.token, crypto.randomUUID(), {
    policyVersion: "mock-allowance-test-v1",
    periodStart: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString(),
  });
  expect(claimed.kind).toBe("ready");
  const id = sessionId(await counted.start(owner.token, slot()));
  expect(await counted.start(owner.token, slot())).toEqual({
    kind: "replayed",
    sessionId: id,
  });
  const units = await pool.query(
    `SELECT available,consumed FROM synthetic_entitlement_grants
     WHERE member_id=$1 AND category='mock_sessions'`,
    [owner.id],
  );
  expect(units.rows).toEqual([{ available: 2, consumed: 1 }]);
});
it("INTERVIEW-07 interview practice is private, exported with its version and erased", async () => {
  const f = await staff();
  const owner = await member(),
    other = await member();
  const id = sessionId(await practice.start(owner.token, slot()));
  expect(
    await practice.append(owner.token, id, {
      expectedSequence: 1,
      response: "Invented private answer",
    }),
  ).toBe("saved");
  for (const value of [other.token, f.editor, f.reviewer]) {
    expect(await practice.detail(value, id)).toBeNull();
    expect(
      await practice.append(value, id, {
        expectedSequence: 2,
        response: "Forged",
      }),
    ).toBe("unavailable");
  }
  const exported = await memberExportStore(pool).exportOwned(owner.token);
  if (exported.kind !== "ready") throw Error("Expected an owned export");
  expect(exported.payload.records.practiceSessions).toEqual([
    expect.objectContaining({ id, promptVersion: INTERVIEW }),
  ]);
  const elsewhere = await memberExportStore(pool).exportOwned(other.token);
  if (elsewhere.kind !== "ready") throw Error("Expected an owned export");
  expect(JSON.stringify(elsewhere.payload)).not.toContain(
    "Invented private answer",
  );
  expect(await practice.withdraw(owner.token, id)).toBe("withdrawn");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM private_practice_exchanges WHERE session_id=$1",
        [id],
      )
    ).rows[0].n,
  ).toBe(0);
  await pool.query("DELETE FROM principals WHERE id=$1", [owner.id]);
  expect(await sessions(owner.id)).toEqual([]);
});
