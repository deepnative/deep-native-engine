import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { memberExportStore } from "../../src/member-export.ts";
import { migrate, store } from "../../src/store.ts";
import { usefulnessStore } from "../../src/usefulness.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const db = store(pool);
const reports = usefulnessStore(pool);
const token = () => randomBytes(32).toString("hex");
const lessonId = "SYN-893";

async function publishLesson(version = 1) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = token();
  const reviewer = token();
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const draft: DraftContent = {
    id: lessonId,
    version,
    kind: "lesson",
    origin: "curated",
    title: `Invented usefulness lesson ${version}`,
    body: "Use only an invented example to choose and check a next step.",
    owner: "Test editor",
    sources: "Original synthetic lesson",
    rights: "Owned test text",
    goals: [],
    backgrounds: [],
    domains: [],
    prerequisites: "None",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, lessonId, version)).toBe(true);
  expect(await catalog.approve(reviewer, lessonId, version, true)).toBe(true);
  expect(await catalog.publish(editor, lessonId, version)).toBe(true);
  return { editor, catalog };
}

async function member(background: "explorer" | "professional" | "technical") {
  const value = token();
  await db.create(value, {
    background,
    goal: background === "explorer" ? "everyday" : "work",
  });
  const session = await db.session(value);
  expect(session.kind).toBe("active");
  return {
    token: value,
    id: session.kind === "active" ? session.learner.id : "",
  };
}

async function selfAssess(id: string, version = 1) {
  expect(await db.openLesson(id, lessonId, version)).toBe(true);
  expect(await db.advanceLesson(id, lessonId, version, "start")).toBe(true);
  expect(await db.advanceLesson(id, lessonId, version, "complete")).toBe(true);
}

beforeAll(async () => migrate(pool));
beforeEach(async () =>
  pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE"),
);
afterAll(async () => pool.end());

it("records one private exact-version report per member and supports stale-safe correction and withdrawal", async () => {
  await publishLesson();
  const people = await Promise.all([
    member("explorer"),
    member("professional"),
    member("technical"),
  ]);
  for (const person of people) {
    expect(await reports.save(person.token, lessonId, 1, "helpful", 0)).toBe(
      false,
    );
    await selfAssess(person.id);
    expect(await reports.save(person.token, lessonId, 1, "helpful", 0)).toBe(
      true,
    );
    expect(await reports.save(person.token, lessonId, 1, "not_yet", 0)).toBe(
      false,
    );
    expect(await reports.list(person.token)).toMatchObject([
      {
        contentId: lessonId,
        contentVersion: 1,
        choice: "helpful",
        revision: 1,
      },
    ]);
  }
  const a = people[0]!;
  const b = people[1]!;
  expect(await reports.list(b.token)).toHaveLength(1);
  expect(await reports.list(token())).toEqual([]);
  const concurrent = await Promise.all([
    reports.save(a.token, lessonId, 1, "not_yet", 1),
    reports.save(a.token, lessonId, 1, "not_yet", 1),
  ]);
  expect(concurrent.sort()).toEqual([false, true]);
  expect(await reports.save(a.token, lessonId, 1, "helpful", 1)).toBe(false);
  expect(await reports.list(a.token)).toMatchObject([
    { choice: "not_yet", revision: 2 },
  ]);
  expect(await reports.withdraw(a.token, lessonId, 1, 1)).toBe(false);
  expect(await reports.withdraw(a.token, lessonId, 1, 2)).toBe(true);
  expect(await reports.list(a.token)).toEqual([]);
  expect(await reports.list(b.token)).toHaveLength(1);
});

it("denies staff, expired and forged writes; retains historical answers but permits their withdrawal", async () => {
  const { editor, catalog } = await publishLesson();
  const a = await member("explorer");
  const b = await member("technical");
  expect(await db.openLesson(a.id, lessonId, 1)).toBe(true);
  expect(await reports.save(a.token, lessonId, 1, "helpful", 0)).toBe(false);
  await db.advanceLesson(a.id, lessonId, 1, "start");
  expect(await reports.save(a.token, lessonId, 1, "helpful", 0)).toBe(false);
  await db.advanceLesson(a.id, lessonId, 1, "complete");
  expect(await reports.save(b.token, lessonId, 1, "helpful", 0)).toBe(false);
  expect(await reports.save(editor, lessonId, 1, "helpful", 0)).toBe(false);
  expect(await reports.save(a.token, lessonId, 2, "helpful", 0)).toBe(false);
  expect(await reports.save(a.token, lessonId, 1, "invalid" as never, 0)).toBe(
    false,
  );
  expect(await reports.save(a.token, lessonId, 1, "helpful", 0)).toBe(true);
  const ownExport = await memberExportStore(pool).exportOwned(a.token);
  expect(ownExport).toMatchObject({
    kind: "ready",
    payload: {
      version: "local-member-records-v9",
      records: {
        lessonUsefulness: [{ choice: "helpful", contentId: lessonId }],
      },
    },
  });
  const otherExport = await memberExportStore(pool).exportOwned(b.token);
  expect(otherExport).toMatchObject({
    kind: "ready",
    payload: { records: { lessonUsefulness: [] } },
  });
  await publishLesson(2);
  expect(await reports.save(a.token, lessonId, 1, "not_yet", 1)).toBe(false);
  expect(await reports.list(a.token)).toMatchObject([
    { choice: "helpful", contentVersion: 1 },
  ]);
  expect(await db.lessonActivities(a.id)).toMatchObject([
    { contentVersion: 1, reportable: false },
  ]);
  expect(await reports.withdraw(a.token, lessonId, 1, 1)).toBe(true);
  expect(await reports.list(a.token)).toEqual([]);
  await selfAssess(a.id, 2);
  expect(await reports.save(a.token, lessonId, 2, "not_yet", 0)).toBe(true);
  expect(await catalog.retire(editor, lessonId)).toBe(true);
  expect(await reports.save(a.token, lessonId, 2, "helpful", 1)).toBe(false);
  expect(await reports.withdraw(a.token, lessonId, 2, 1)).toBe(true);
  await pool.query(
    "UPDATE principals SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=$1",
    [a.id],
  );
  expect(await reports.list(a.token)).toEqual([]);
  expect(await reports.withdraw(a.token, lessonId, 2, 1)).toBe(false);
  await pool.query("DELETE FROM learners WHERE id=$1", [a.id]);
  expect(
    (
      await pool.query("SELECT 1 FROM lesson_usefulness WHERE member_id=$1", [
        a.id,
      ])
    ).rowCount,
  ).toBe(0);
});
