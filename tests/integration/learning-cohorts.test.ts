import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { exactMetrics, metricsStore } from "../../src/metrics.ts";
import { migrate, store } from "../../src/store.ts";
import { testPool } from "../support/database.ts";

const pool = testPool(),
  members = store(pool),
  metrics = metricsStore(pool);
beforeAll(() => migrate(pool));
beforeEach(async () => {
  await pool.query("TRUNCATE principals CASCADE");
  await pool.query("DELETE FROM content_versions WHERE id LIKE 'COH-%'");
  await pool.query(`INSERT INTO content_versions(id,version,kind,origin,title,body,owner,sources,rights)
    VALUES('COH-001',1,'lesson','curated','Invented lesson','Invented body','Test','Test','Owned')`);
});
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
async function joined(
  background: "explorer" | "professional" | "technical",
  goal: "everyday" | "work" | "build",
  when?: string,
  tags: string[] = [],
) {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background, goal });
  const session = await members.session(token);
  if (session.kind !== "active") throw Error("No invented member");
  const id = session.learner.id;
  if (when)
    await pool.query("UPDATE principals SET created_at=$2 WHERE id=$1", [
      id,
      when,
    ]);
  if (tags.length)
    await pool.query("UPDATE learners SET background_tags=$2 WHERE id=$1", [
      id,
      tags,
    ]);
  return id;
}
const opened = (id: string, at: string) =>
  pool.query(
    "INSERT INTO lesson_activity(member_id,content_id,content_version,opened_at) VALUES($1,'COH-001',1,$2)",
    [id, at],
  );

it("MET-SUPP-01 serves no exact count below or above the threshold", async () => {
  const token = await operator();
  for (let index = 0; index < 19; index++) await joined("explorer", "everyday");
  const small = await metrics.snapshot(token);
  expect(small?.learning).toMatchObject({
    disclosure: "suppressed",
    members: null,
  });
  expect((await exactMetrics(pool, token))?.members).toBe(19);
  await joined("explorer", "everyday");
  const large = await metrics.snapshot(token);
  expect(large?.learning.members).toBe("20-49");
  expect(large).not.toHaveProperty("counts");
  const served = JSON.stringify({
    learning: large?.learning,
    segments: large?.segments,
    cohorts: large?.cohorts,
  });
  expect(served).not.toMatch(/"(members|activated)":\d/);
});

it("MET-SEG-01/02 groups three audiences with overlapping tags and suppresses small complements", async () => {
  const token = await operator();
  for (let index = 0; index < 20; index++) {
    await joined("explorer", "everyday", undefined, ["explorer"]);
    await joined("professional", "work", undefined, ["explorer", "technical"]);
    await joined("technical", "build", undefined, ["technical"]);
  }
  const raw = await exactMetrics(pool, token);
  expect(raw?.segments).toMatchObject({
    background: { explorer: { members: 20 }, technical: { members: 20 } },
    goal: { work: { members: 20 } },
    // Overlapping tags add up to more than the 60 members.
    interests: { explorer: { members: 40 }, technical: { members: 40 } },
  });
  const { segments } = (await metrics.snapshot(token))!;
  for (const segment of [...segments.background, ...segments.goal])
    expect(segment.members).toBe("20-49");
  expect(segments.interests.find((s) => s.key === "technical")?.members).toBe(
    "20-49",
  );
  // No one chose this interest tag; it reads the same as a small group.
  expect(
    segments.interests.find((s) => s.key === "professional"),
  ).toMatchObject({ disclosure: "suppressed", members: null });
  expect(JSON.stringify(segments)).not.toMatch(/paid|tier|career|staff/i);
});

it("MET-COH-01/02/03 counts only fixed windows from join time, hides open months and loses deleted accounts", async () => {
  const token = await operator();
  const start = "2026-01-10T12:00:00Z";
  const ids: string[] = [];
  for (let index = 0; index < 30; index++)
    ids.push(await joined("professional", "work", start));
  for (const id of ids.slice(0, 10)) await opened(id, "2026-01-20T12:00:00Z");
  // After day 14: not activation. Inside day 7–30: continuation.
  for (const id of ids.slice(10, 16)) await opened(id, "2026-01-25T12:00:00Z");
  // After day 30: counts for neither.
  for (const id of ids.slice(16, 22)) await opened(id, "2026-03-01T12:00:00Z");
  await joined("explorer", "everyday");
  const raw = (await exactMetrics(pool, token))!;
  const cohorts = raw.cohorts as { month: string; closed: boolean }[];
  expect(cohorts[0]!.closed).toBe(false);
  expect(cohorts.find((c) => c.month === "2026-01")).toMatchObject({
    closed: true,
    members: 30,
    activated: 10,
    continued: 16,
  });
  const served = (await metrics.snapshot(token))!;
  expect(served.cohorts[0]).toMatchObject({
    disclosure: "window-open",
    members: null,
  });
  expect(served.cohorts.find((c) => c.month === "2026-01")).toMatchObject({
    disclosure: "coarse-band",
    members: "20-49",
    values: { activated: "5-19", continued: "5-19", selfAssessed: null },
  });
  for (const id of ids.slice(0, 11)) await members.remove(id);
  const after = (await metrics.snapshot(token))!;
  expect(after.cohorts.find((c) => c.month === "2026-01")).toMatchObject({
    disclosure: "suppressed",
    members: null,
  });
});

it("MET-SUPP-01 still denies a member and reads nothing without authority", async () => {
  const token = randomBytes(32).toString("hex");
  await members.create(token, { background: "explorer", goal: "everyday" });
  expect(await metrics.snapshot(token)).toBeNull();
  expect(await exactMetrics(pool, token)).toBeNull();
});
