import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { testPool } from "../support/database.ts";
import { migrate } from "../../src/store.ts";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";

const pool = testPool();
const catalog = catalogStore(pool);
const token = () => randomBytes(32).toString("hex");
beforeAll(async () => {
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterEach(async () => {
  await pool.query("TRUNCATE adapter_jobs, principals, cohorts CASCADE");
});
afterAll(async () => {
  await pool.end();
});

it("keeps controlled synthetic audience tags on exact versions and denies noneditors", async () => {
  const auth = authorizationStore(pool);
  const editor = token();
  const reviewer = token();
  const coach = token();
  const expiresAt = new Date(Date.now() + 86_400_000);
  const editorId = await auth.provisionStaff(editor, "editor", expiresAt);
  await auth.provisionStaff(reviewer, "reviewer", expiresAt);
  await auth.provisionStaff(coach, "coach", expiresAt);
  const first: DraftContent = {
    id: "SYN-780",
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented general lesson",
    body: "Use invented examples only.",
    owner: "Synthetic editor",
    sources: "Original local text",
    rights: "Owned synthetic text",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: ["education"],
    prerequisites: "",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(reviewer, first)).toBe(false);
  expect(await catalog.createDraft(coach, first)).toBe(false);
  expect(await catalog.createDraft("unassigned", first)).toBe(false);
  for (const invalid of [
    { ...first, goals: ["everyday", "everyday"] },
    { ...first, backgrounds: ["unknown"] },
    {
      ...first,
      domains: [
        "education",
        "finance",
        "health",
        "creative",
        "public",
        "operations",
        "education",
      ],
    },
  ]) {
    expect(await catalog.createDraft(editor, invalid)).toBe(false);
  }
  expect(await catalog.createDraft(editor, first)).toBe(true);
  expect(await catalog.preview(editor, first.id, 1)).toMatchObject({
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: ["education"],
  });
  expect(await catalog.published(first.id)).toBeNull();
  expect(await catalog.submit(editor, first.id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, first.id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, first.id, 1)).toBe(true);
  const second = {
    ...first,
    version: 2,
    title: "Invented technical lesson",
    goals: ["build"],
    backgrounds: ["technical"],
    domains: ["operations"],
  };
  expect(await catalog.createDraft(editor, second)).toBe(true);
  expect((await catalog.published(first.id))?.version).toBe(1);
  expect(await catalog.submit(editor, first.id, 2)).toBe(true);
  expect(await catalog.approve(reviewer, first.id, 2, true)).toBe(true);
  expect(await catalog.publish(editor, first.id, 2)).toBe(true);
  expect(await catalog.published(first.id)).toMatchObject({
    version: 2,
    goals: ["build"],
    backgrounds: ["technical"],
    domains: ["operations"],
  });
  expect(await catalog.preview(reviewer, first.id, 1)).toMatchObject({
    version: 1,
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: ["education"],
  });
  await pool.query(
    "UPDATE principals SET revoked_at=CURRENT_TIMESTAMP WHERE id=$1",
    [editorId],
  );
  expect(await catalog.createDraft(editor, { ...second, version: 3 })).toBe(
    false,
  );
  expect(await catalog.preview(editor, first.id, 1)).toBeNull();
  expect(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM content_versions WHERE id=$1",
        [first.id],
      )
    ).rows[0].count,
  ).toBe(2);
});
