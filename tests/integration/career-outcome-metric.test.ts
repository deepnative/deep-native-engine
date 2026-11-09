import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { exactMetrics, metricsStore } from "../../src/metrics.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

// #123 OUTCOME: member-reported career outcomes in the private learning
// snapshot, on real PostgreSQL with invented members only.
const pool = testPool(),
  members = store(pool),
  metrics = metricsStore(pool);
beforeAll(() => migrate(pool));
beforeEach(() => pool.query("TRUNCATE principals CASCADE"));
afterAll(() => pool.end());

async function operator() {
  const token = randomBytes(32).toString("hex");
  await authorizationStore(pool).provisionStaff(
    token,
    "operator",
    new Date(Date.now() + 3600000),
  );
  return token;
}
async function member(goal: "everyday" | "work" | "build" = "everyday") {
  const token = randomBytes(32).toString("hex");
  await members.create(token, {
    background: goal === "build" ? "technical" : "explorer",
    goal,
  });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("No invented member");
  return { token, id: session.learner.id };
}
async function entry(memberId: string, outcome: string, kind = "career") {
  await pool.query(
    "INSERT INTO career_preferences(member_id) VALUES($1) ON CONFLICT DO NOTHING",
    [memberId],
  );
  await pool.query(
    `INSERT INTO career_entries(id,member_id,kind,title,next_action,self_reported_outcome)
     VALUES($1,$2,$3,'Invented plan','Invented next step',$4)`,
    [randomUUID(), memberId, kind, outcome],
  );
}

it("OUTCOME-01 counts each member once who reported an outcome, and not those with plans only", async () => {
  const token = await operator();
  const all = [];
  for (let index = 0; index < 30; index++) all.push(await member());
  // Eight report an outcome; one of them on two entries of different kinds.
  for (const [index, person] of all.slice(0, 8).entries())
    await entry(person.id, `Invented outcome ${index}`);
  await entry(all[0]!.id, "Another invented outcome", "contract");
  // A plan with no outcome, or only spaces, is not a reported outcome.
  await entry(all[8]!.id, "");
  await entry(all[9]!.id, "   ");
  const raw = (await exactMetrics(pool, token))!;
  expect(raw.members).toBe(30);
  expect(raw.reportedOutcome).toBe(8);
  const snapshot = (await metrics.snapshot(token))!;
  expect(snapshot.learning.values.reportedOutcome).toBe("5-19");
  expect(snapshot.definitions.reportedOutcome).toMatch(/member-reported/i);
  expect(snapshot.definitions.reportedOutcome).toMatch(/not verified/i);
  expect(JSON.stringify(snapshot)).not.toContain("Invented outcome");
});

it("OUTCOME-02 small counts and near-total counts are suppressed, and segments carry the measure", async () => {
  const token = await operator();
  const builders = [];
  for (let index = 0; index < 25; index++) await member("everyday");
  for (let index = 0; index < 25; index++) builders.push(await member("build"));
  for (const person of builders.slice(0, 4))
    await entry(person.id, "Invented outcome");
  let snapshot = (await metrics.snapshot(token))!;
  // Four is below the smallest disclosed value.
  expect(snapshot.learning.values.reportedOutcome).toBeNull();
  for (const person of builders.slice(4)) await entry(person.id, "Invented");
  const raw = (await exactMetrics(pool, token))!;
  expect(raw.reportedOutcome).toBe(25);
  snapshot = (await metrics.snapshot(token))!;
  expect(snapshot.learning.values.reportedOutcome).toBe("20-49");
  const build = snapshot.segments.goal.find((s) => s.key === "build")!;
  // Every member of the segment reported one: within five of its total.
  expect(build.values.reportedOutcome).toBeNull();
  const everyday = snapshot.segments.goal.find((s) => s.key === "everyday")!;
  expect(everyday.values.reportedOutcome).toBeNull();
});

it("OUTCOME-03 deleted accounts leave the count, and members cannot read it", async () => {
  const token = await operator();
  const all = [];
  for (let index = 0; index < 25; index++) all.push(await member());
  for (const person of all.slice(0, 6)) await entry(person.id, "Invented");
  expect((await exactMetrics(pool, token))!.reportedOutcome).toBe(6);
  await pool.query("DELETE FROM principals WHERE id=$1", [all[0]!.id]);
  expect((await exactMetrics(pool, token))!.reportedOutcome).toBe(5);
  expect(await metrics.snapshot(all[1]!.token)).toBeNull();
});
