import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { metricsStore } from "../../src/metrics.ts";
import { migrate, store } from "../../src/store.ts";
import { usefulnessStore } from "../../src/usefulness.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const reports = usefulnessStore(pool);
const metrics = metricsStore(pool);
const token = () => randomBytes(32).toString("hex");
const lessonId = "UMT-309";

async function staff(
  role: "operator" | "platform_admin" | "reviewer" | "editor",
) {
  const value = token();
  const id = await authorizationStore(pool).provisionStaff(
    value,
    role,
    new Date(Date.now() + 86_400_000),
  );
  return { token: value, id };
}

async function publish(version: number, editor: string, reviewer: string) {
  const catalog = catalogStore(pool);
  const draft: DraftContent = {
    id: lessonId,
    version,
    kind: "lesson",
    origin: "curated",
    title: `Invented usefulness lesson ${version}`,
    body: "Choose one practical next step using invented details.",
    owner: "Synthetic editor",
    sources: "Original invented source",
    rights: "Owned synthetic text",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, lessonId, version)).toBe(true);
  expect(await catalog.approve(reviewer, lessonId, version, true)).toBe(true);
  expect(await catalog.publish(editor, lessonId, version)).toBe(true);
}

async function respondent(
  background: "explorer" | "professional" | "technical",
) {
  const value = token();
  await db.create(value, {
    background,
    goal: background === "explorer" ? "everyday" : "work",
  });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  if (session.kind !== "active")
    throw new Error("Synthetic member unavailable");
  return { token: value, id: session.learner.id };
}

async function selfAssess(memberId: string, version: number) {
  expect(await db.openLesson(memberId, lessonId, version)).toBe(true);
  expect(await db.advanceLesson(memberId, lessonId, version, "start")).toBe(
    true,
  );
  expect(await db.advanceLesson(memberId, lessonId, version, "complete")).toBe(
    true,
  );
}

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

it("discloses only a coarse latest-answer band for a large retained cohort and suppresses small cells", async () => {
  const operator = await staff("operator");
  const admin = await staff("platform_admin");
  const reviewer = await staff("reviewer");
  const editor = await staff("editor");
  await publish(1, editor.token, reviewer.token);
  const people: Awaited<ReturnType<typeof respondent>>[] = [];
  for (let index = 0; index < 20; index += 1) {
    const background = (["explorer", "professional", "technical"] as const)[
      index % 3
    ]!;
    const person = await respondent(background);
    people.push(person);
    await selfAssess(person.id, 1);
    expect(
      await reports.save(
        person.token,
        lessonId,
        1,
        index < 10 ? "helpful" : "not_yet",
        0,
      ),
    ).toBe(true);
    if (index === 18)
      expect((await metrics.snapshot(operator.token))?.usefulness).toEqual({
        disclosure: "suppressed",
        helpfulShareBand: null,
      });
  }
  expect((await metrics.snapshot(operator.token))?.usefulness).toEqual({
    disclosure: "coarse-band",
    helpfulShareBand: "50-74%",
  });
  expect((await metrics.snapshot(admin.token))?.usefulness.disclosure).toBe(
    "coarse-band",
  );
  expect(await metrics.snapshot(reviewer.token)).toBeNull();
  expect(await metrics.snapshot(people[0]!.token)).toBeNull();
  expect(await metrics.snapshot(editor.token)).toBeNull();
  const first = people[0]!;
  const published = await metrics.snapshot(operator.token);
  expect(JSON.stringify(published)).not.toContain(first.id);
  expect(JSON.stringify(published)).not.toContain(lessonId);
  expect(JSON.stringify(published)).not.toContain("usefulnessRespondents");

  for (const person of people.slice(10, 16))
    expect(await reports.save(person.token, lessonId, 1, "helpful", 1)).toBe(
      true,
    );
  expect((await metrics.snapshot(operator.token))?.usefulness).toEqual({
    disclosure: "suppressed",
    helpfulShareBand: null,
  });
  for (const person of people.slice(10, 16))
    expect(await reports.save(person.token, lessonId, 1, "not_yet", 2)).toBe(
      true,
    );
  expect(
    (await metrics.snapshot(operator.token))?.usefulness.helpfulShareBand,
  ).toBe("50-74%");

  // A member with an expired session remains a retained respondent.
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [people[19]!.id],
  );
  expect((await metrics.snapshot(operator.token))?.usefulness.disclosure).toBe(
    "coarse-band",
  );
  await publish(2, editor.token, reviewer.token);
  await selfAssess(first.id, 2);
  expect(await reports.save(first.token, lessonId, 2, "not_yet", 0)).toBe(true);
  // Equal timestamps cannot double-count a member or make the older version win.
  await pool.query(
    "UPDATE lesson_usefulness SET reported_at='2026-09-01T00:00:00Z',updated_at='2026-09-01T00:00:00Z' WHERE member_id=$1",
    [first.id],
  );
  expect((await metrics.snapshot(operator.token))?.usefulness).toEqual({
    disclosure: "coarse-band",
    helpfulShareBand: "25-49%",
  });
  expect(await reports.save(first.token, lessonId, 2, "helpful", 1)).toBe(true);
  expect(
    (await metrics.snapshot(operator.token))?.usefulness.helpfulShareBand,
  ).toBe("50-74%");
  expect(await reports.withdraw(first.token, lessonId, 2, 2)).toBe(true);
  expect(
    (await metrics.snapshot(operator.token))?.usefulness.helpfulShareBand,
  ).toBe("50-74%");
  expect(await reports.withdraw(first.token, lessonId, 1, 1)).toBe(true);
  expect((await metrics.snapshot(operator.token))?.usefulness.disclosure).toBe(
    "suppressed",
  );
  // Removing an account cascades both its activity and its usefulness answer.
  await pool.query("DELETE FROM principals WHERE id=$1", [people[1]!.id]);
  expect(
    (
      await pool.query("SELECT 1 FROM lesson_usefulness WHERE member_id=$1", [
        people[1]!.id,
      ])
    ).rowCount,
  ).toBe(0);
  expect((await metrics.snapshot(operator.token))?.usefulness.disclosure).toBe(
    "suppressed",
  );
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [operator.id],
  );
  expect(await metrics.snapshot(operator.token)).toBeNull();
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP WHERE id=$1",
    [admin.id],
  );
  expect(await metrics.snapshot(admin.token)).toBeNull();
});
