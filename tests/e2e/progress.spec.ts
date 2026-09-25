import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.use({ trace: "on" });
test.afterAll(async () => pool.end());

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("explorer");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function publishSamples(lessonId: string, assignmentId: string) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const base = {
    version: 1,
    origin: "curated" as const,
    owner: "Synthetic test editor",
    sources: "Original invented teaching sample",
    rights: "Owned local test text",
    goals: ["everyday"] as DraftContent["goals"],
    backgrounds: ["explorer"] as DraftContent["backgrounds"],
    domains: [] as DraftContent["domains"],
    prerequisites: "None",
    minimumExperience: "new" as const,
  };
  for (const item of [
    {
      ...base,
      id: lessonId,
      kind: "lesson" as const,
      title: "Invented cross-content reading",
      body: "Use an invented situation and check each source before acting.",
      rubric: null,
      rubricVersion: null,
    },
    {
      ...base,
      id: assignmentId,
      kind: "assignment" as const,
      title: `Invented cross-content project ${assignmentId}`,
      body: "Draft a practical plan using only invented details.",
      rubric: "Compare each action to the invented brief.",
      rubricVersion: 1,
    },
  ]) {
    expect(await catalog.createDraft(editor, item)).toBe(true);
    expect(await catalog.submit(editor, item.id, item.version)).toBe(true);
    expect(await catalog.approve(reviewer, item.id, item.version, true)).toBe(
      true,
    );
    expect(await catalog.publish(editor, item.id, item.version)).toBe(true);
  }
  return { catalog, editor, reviewer };
}

test("[L62] member sees only their exact-version activity with truthful progress and historical states", async ({
  page,
  context,
  browser,
}, info) => {
  const lessonId =
    info.project.name === "desktop-chromium" ? "SYN-982" : "SYN-984";
  const assignmentId =
    info.project.name === "desktop-chromium" ? "SYN-983" : "SYN-985";
  const actors = await publishSamples(lessonId, assignmentId);
  await onboard(page);
  const cookie = (await context.cookies()).find(
    (item) => item.name === "dne_preview",
  );
  expect(cookie).toBeDefined();
  const tokenHash = createHash("sha256").update(cookie!.value).digest("hex");
  const owner = await pool.query<{ id: string }>(
    "SELECT id FROM learners WHERE token_hash=$1",
    [tokenHash],
  );
  expect(owner.rowCount).toBe(1);
  const ownerId = owner.rows[0]!.id;

  await page
    .getByRole("link", { name: "View private learning activity" })
    .click();
  await expect(
    page.getByText("No learning activity has been saved in this preview yet"),
  ).toBeVisible();
  await page.goto("/lesson");
  await page
    .getByLabel("Your instruction to AI")
    .fill(
      "Using only invented notes, draft a short plan with clear next steps.",
    );
  await page
    .getByLabel("How will you check the result?")
    .fill("Compare each proposed step with the invented notes and check gaps.");
  await page.getByLabel("I checked the context").check();
  await page.getByRole("button", { name: "Complete exercise" }).click();
  await expect(page.getByText("Exercise completed")).toBeVisible();

  await page.goto(`/library/${lessonId}`);
  await expect(
    page.getByRole("heading", { name: "Invented cross-content reading" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start this lesson" }).click();
  await expect(page.getByRole("status")).toContainText("Started");
  await page.goto("/learn");
  const choices = page.getByRole("region", {
    name: "Choose a practice assignment",
  });
  await choices
    .getByRole("button", {
      name: `Choose Invented cross-content project ${assignmentId}`,
    })
    .click();
  await choices
    .getByRole("button", { name: "Start or return to this private attempt" })
    .click();
  const attemptId = page.url().split("/").at(-1)!;
  await page
    .getByLabel("Private sample response")
    .fill("An invented project plan with three actions and a source check.");
  await page.getByLabel("I used only invented or sample information").check();
  await page.getByRole("button", { name: "Save private draft" }).click();
  await page.getByLabel("Submit this saved version locally").check();
  await page
    .getByRole("button", { name: "Submit saved version locally" })
    .click();

  await page.goto("/progress");
  await expect(
    page.getByRole("heading", { name: "Your private learning activity" }),
  ).toBeVisible();
  await expect(page.locator("main ol > li")).toHaveCount(3);
  const starter = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Give AI a clear starting point" }),
  });
  await expect(starter).toContainText("Self-reported complete");
  const reading = page.getByRole("listitem").filter({
    has: page.getByRole("heading", {
      name: "Invented cross-content reading",
      exact: true,
    }),
  });
  await expect(reading).toContainText("sample lesson · version 1 · Started");
  await expect(reading).not.toContainText("Self-reported complete");
  const assignment = page.getByRole("listitem").filter({
    has: page.getByRole("heading", {
      name: `Invented cross-content project ${assignmentId}`,
    }),
  });
  await expect(assignment).toContainText(
    "Submitted locally; no qualified review",
  );
  await expect(assignment.getByRole("link")).toHaveAttribute(
    "href",
    `/assignments/attempts/${attemptId}`,
  );
  const persisted = await pool.query(
    `SELECT (SELECT count(*) FROM exercises WHERE learner_id=$1) AS exercises,
            (SELECT count(*) FROM lesson_activity WHERE member_id=$1) AS lessons,
            (SELECT count(*) FROM assignment_attempts WHERE member_id=$1) AS attempts`,
    [ownerId],
  );
  expect(persisted.rows[0]).toEqual({
    exercises: "1",
    lessons: "1",
    attempts: "1",
  });

  const replacement: DraftContent = {
    id: lessonId,
    version: 2,
    kind: "lesson",
    origin: "curated",
    owner: "Synthetic test editor",
    sources: "Original invented teaching sample, revised",
    rights: "Owned local test text",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    title: "Invented cross-content reading, version two",
    body: "Use a revised invented situation and check its source.",
    rubric: null,
    rubricVersion: null,
  };
  expect(await actors.catalog.createDraft(actors.editor, replacement)).toBe(
    true,
  );
  expect(await actors.catalog.submit(actors.editor, lessonId, 2)).toBe(true);
  expect(await actors.catalog.approve(actors.reviewer, lessonId, 2, true)).toBe(
    true,
  );
  expect(await actors.catalog.publish(actors.editor, lessonId, 2)).toBe(true);
  await page.goto("/progress");
  await expect(reading).toContainText("version 1");
  await expect(reading).toContainText("Historical version unavailable");
  await expect(reading.getByRole("link")).toHaveCount(0);
  await page.goto(`/library/${lessonId}`);
  await expect(
    page.getByRole("heading", {
      name: "Invented cross-content reading, version two",
    }),
  ).toBeVisible();
  await page.goto("/progress");
  const replacementReading = page.getByRole("listitem").filter({
    has: page.getByRole("heading", {
      name: "Invented cross-content reading, version two",
    }),
  });
  await expect(replacementReading).toContainText(
    "version 2 · Opened in reader",
  );
  await expect(replacementReading).toContainText("Current published sample");
  await expect(page.locator("main ol > li")).toHaveCount(4);

  await page.goto("/learn");
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByRole("button", { name: "Save my direction" }).click();
  expect(await actors.catalog.retire(actors.editor, lessonId)).toBe(true);
  await page.goto("/progress");
  await page.reload();
  await expect(reading).toContainText("version 1");
  await expect(reading).toContainText("Historical version unavailable");
  await expect(reading.getByRole("link")).toHaveCount(0);
  await expect(replacementReading).toContainText(
    "Historical version unavailable",
  );
  await expect(replacementReading.getByRole("link")).toHaveCount(0);
  await expect(assignment).toContainText(
    "Not eligible for your current direction; history retained",
  );
  await expect(assignment.getByRole("link")).toHaveAttribute(
    "href",
    `/assignments/attempts/${attemptId}`,
  );

  const other = await browser.newContext({ baseURL: origin });
  try {
    const otherPage = await other.newPage();
    await onboard(otherPage);
    await otherPage.goto(`/progress?member_id=${ownerId}`);
    await expect(
      otherPage.getByText(
        "No learning activity has been saved in this preview yet",
      ),
    ).toBeVisible();
    await expect(
      otherPage.getByText("Invented cross-content project"),
    ).toHaveCount(0);
    await otherPage.goto(`/assignments/attempts/${attemptId}`);
    await expect(
      otherPage.getByText("Invented cross-content project"),
    ).toHaveCount(0);
  } finally {
    await other.close();
  }
});
