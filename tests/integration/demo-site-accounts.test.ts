import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { exactMetrics, metricsStore } from "../../src/metrics.ts";
import { proposalStore } from "../../src/proposals.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// #123 DEMOACCT: accounts created while the site runs as a demo never count
// in another site's metrics, on real PostgreSQL with invented members only.
const pool = testPool(),
  liveMembers = store(pool),
  demoMembers = store(pool, { demoSite: true }),
  proposals = proposalStore(pool, undefined, { ordinaryEnabled: true });
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  await pool.query("DELETE FROM content_versions WHERE id LIKE 'DMA-%'");
  await pool.query(`INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
    VALUES('DMA-001',1,'lesson','curated','Invented lesson','Invented body','Test','Test','Owned')`);
});
afterAll(() => pool.end());

const token = () => randomBytes(32).toString("hex");
async function operator() {
  const value = token();
  await authorizationStore(pool).provisionStaff(
    value,
    "operator",
    new Date(Date.now() + 3600000),
  );
  return value;
}
async function member(demo: boolean, goal: "everyday" | "build" = "everyday") {
  const value = token();
  await (demo ? demoMembers : liveMembers).create(value, {
    background: goal === "build" ? "technical" : "explorer",
    goal,
  });
  const session = await liveMembers.session(value);
  if (session.kind !== "active") throw Error("No invented member");
  return { token: value, id: session.learner.id };
}
const demoOrigin = async (id: string) =>
  (
    await pool.query<{ demo: boolean }>(
      "SELECT created_on_demo_site AS demo FROM learners WHERE id=$1",
      [id],
    )
  ).rows[0]!.demo;
/** Gives a member every kind of activity the snapshot counts. */
async function active(person: { token: string; id: string }, n: number) {
  await pool.query(
    "INSERT INTO lesson_activity(member_id,content_id,content_version,opened_at,started_at,self_assessed_at) VALUES($1,'DMA-001',1,now(),now(),now())",
    [person.id],
  );
  await pool.query(
    "INSERT INTO lesson_usefulness(member_id,content_id,content_version,choice) VALUES($1,'DMA-001',1,'helpful')",
    [person.id],
  );
  await pool.query(
    "INSERT INTO career_preferences(member_id) VALUES($1) ON CONFLICT DO NOTHING",
    [person.id],
  );
  await pool.query(
    `INSERT INTO career_entries(id,member_id,kind,title,next_action,self_reported_outcome)
     VALUES(gen_random_uuid(),$1,'career','Invented plan','Invented step','Invented outcome')`,
    [person.id],
  );
  const draft = (await proposals.createDraft(
    person.token,
    {
      title: `Invented member method ${n}`,
      body: "Original invented text with two source checks.",
      sources: "Original fixture text only.",
    },
    false,
  ))!;
  expect(await proposals.submit(person.token, draft, true, 1)).toBe(
    "submitted",
  );
}
type Raw = NonNullable<Awaited<ReturnType<typeof exactMetrics>>>;
const counted = (raw: Raw) => ({
  members: raw.members,
  activated: raw.activated,
  selfAssessed: raw.selfAssessed,
  reportedOutcome: raw.reportedOutcome,
  usefulnessRespondents: raw.usefulnessRespondents,
  contributors: (raw.contributions as Record<string, { contributors: number }>)
    .member!.contributors,
  cohortMembers: (raw.cohorts as { members: number }[]).reduce(
    (sum, c) => sum + c.members,
    0,
  ),
  goals: Object.fromEntries(
    Object.entries(
      (raw.segments as { goal: Record<string, { members: number }> }).goal ??
        {},
    ).map(([key, cell]) => [key, cell.members]),
  ),
});

it("DEMOACCT-01 an account created on a demo site is a demo account, and one created elsewhere isn't", async () => {
  const demo = await member(true);
  const live = await member(false);
  expect(await demoOrigin(demo.id)).toBe(true);
  expect(await demoOrigin(live.id)).toBe(false);
});

it("DEMOACCT-02 an account's demo origin cannot be changed afterwards", async () => {
  const demo = await member(true);
  await expect(
    pool.query("UPDATE learners SET created_on_demo_site=false WHERE id=$1", [
      demo.id,
    ]),
  ).rejects.toThrow(/demo origin cannot change/);
  // Other profile changes still save.
  await pool.query("UPDATE learners SET goal='work' WHERE id=$1", [demo.id]);
  expect(await demoOrigin(demo.id)).toBe(true);
});

it("DEMOACCT-02 accounts that existed before the change are recorded as demo accounts", async () => {
  const before = await member(false);
  const client = await pool.connect();
  try {
    // Replays migration 124 on a database that had accounts without the column.
    await client.query("BEGIN");
    await client.query(
      "DROP TRIGGER learners_demo_site_fixed ON learners; ALTER TABLE learners DROP COLUMN created_on_demo_site; DELETE FROM schema_migrations WHERE version=124",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await migrate(pool);
  expect(await demoOrigin(before.id)).toBe(true);
  // Running migrations again changes nothing, and new accounts follow the site.
  await migrate(pool);
  expect(await demoOrigin(before.id)).toBe(true);
  expect(await demoOrigin((await member(false)).id)).toBe(false);
});

it("DEMOACCT-03 a site that isn't a demo counts no demo account or its activity", async () => {
  const staff = await operator();
  const live = [];
  for (let index = 0; index < 22; index++)
    live.push(await member(false, index < 11 ? "everyday" : "build"));
  for (const [index, person] of live.slice(0, 6).entries())
    await active(person, index);
  const before = counted((await exactMetrics(pool, staff, false))!);
  expect(before).toEqual({
    members: 22,
    activated: 6,
    selfAssessed: 6,
    reportedOutcome: 6,
    usefulnessRespondents: 6,
    contributors: 6,
    cohortMembers: 22,
    goals: { everyday: 11, build: 11 },
  });
  // Demo accounts with every kind of activity change no figure.
  for (let index = 0; index < 8; index++)
    await active(await member(true, "build"), 100 + index);
  expect(counted((await exactMetrics(pool, staff, false))!)).toEqual(before);
  const snapshot = (await metricsStore(pool).snapshot(staff))!;
  expect(snapshot.accounts).toBe("not-demo");
  expect(snapshot.definitions.accounts).toMatch(
    /not created while the site ran as a demo/,
  );
  expect(snapshot.learning.members).toBe("20-49");
});

it("DEMOACCT-04 a demo site counts only its demo accounts and says they are test data", async () => {
  const staff = await operator();
  for (let index = 0; index < 5; index++)
    await active(await member(false), index);
  const demo = [];
  for (let index = 0; index < 21; index++) demo.push(await member(true));
  for (const [index, person] of demo.slice(0, 7).entries())
    await active(person, 50 + index);
  expect(counted((await exactMetrics(pool, staff, true))!)).toEqual({
    members: 21,
    activated: 7,
    selfAssessed: 7,
    reportedOutcome: 7,
    usefulnessRespondents: 7,
    contributors: 7,
    cohortMembers: 21,
    goals: { everyday: 21 },
  });
  const snapshot = (await metricsStore(pool, { demoSite: true }).snapshot(
    staff,
  ))!;
  expect(snapshot.accounts).toBe("demo");
  expect(snapshot.definitions.accounts).toMatch(/test data, not live figures/);
  // Access is unchanged: a member still gets nothing.
  expect(
    await metricsStore(pool, { demoSite: true }).snapshot(demo[0]!.token),
  ).toBeNull();
});
