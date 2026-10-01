import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { hash } from "../../src/store.ts";
import { COOKIE } from "../../src/session.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
const origin = "http://127.0.0.1:4317";
test.use({ trace: "on" });
test.afterAll(async () => pool.end());

async function onboard(page: Page) {
  await page.goto("/");
  await page.getByLabel("Your starting point").selectOption("professional");
  await page.getByLabel("What would you like to do?").selectOption("work");
  await page.getByLabel("I'll use invented or sample information").check();
  await page.getByRole("button", { name: "Start my learning path" }).click();
  await expect(page).toHaveURL(/\/learn$/);
}

async function publishLesson(id: string) {
  const auth = authorizationStore(pool);
  const catalog = catalogStore(pool);
  const editor = randomBytes(32).toString("hex");
  const reviewer = randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + 86_400_000);
  await auth.provisionStaff(editor, "editor", expiry);
  await auth.provisionStaff(reviewer, "reviewer", expiry);
  const draft: DraftContent = {
    id,
    version: 1,
    kind: "lesson",
    origin: "curated",
    title: "Invented practical step",
    body: "Choose a practical next step using invented facts only.",
    owner: "Synthetic editor",
    sources: "Original invented source",
    rights: "Owned synthetic text",
    goals: ["work"],
    backgrounds: ["professional"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
  expect(await catalog.createDraft(editor, draft)).toBe(true);
  expect(await catalog.submit(editor, id, 1)).toBe(true);
  expect(await catalog.approve(reviewer, id, 1, true)).toBe(true);
  expect(await catalog.publish(editor, id, 1)).toBe(true);
  return { catalog, editor };
}

test("[L69] a member privately reports, corrects and withdraws exact-version usefulness without exposing it", async ({
  page,
  browser,
}, info) => {
  const lessonId =
    info.project.name === "desktop-chromium" ? "SYN-986" : "SYN-987";
  const actors = await publishLesson(lessonId);
  await onboard(page);
  await page.goto(`/library/${lessonId}`);
  await page.getByRole("button", { name: "Start this lesson" }).click();
  await page.goto("/progress");
  const activity = page.getByRole("listitem").filter({
    has: page.getByRole("heading", { name: "Invented practical step" }),
  });
  await expect(activity).not.toContainText("Private lesson usefulness");
  await page.goto(`/library/${lessonId}`);
  await page.getByLabel("I have finished reading this sample lesson").check();
  await page
    .getByRole("button", { name: "Mark self-assessed complete" })
    .click();
  await page
    .getByRole("link", { name: "Report whether this sample helped" })
    .click();
  await expect(activity).toContainText("Was this sample lesson helpful");
  await activity.getByLabel("Your answer").selectOption("helpful");
  await activity
    .getByLabel("This is my own response about sample learning")
    .check();
  await activity
    .getByRole("button", { name: "Save my usefulness answer" })
    .click();
  await expect(activity).toContainText(
    "Your current answer: Helpful for my next step",
  );
  await activity.getByLabel("Your answer").selectOption("not_yet");
  await activity
    .getByLabel("This is my own response about sample learning")
    .check();
  await activity
    .getByRole("button", { name: "Correct my usefulness answer" })
    .click();
  await expect(activity).toContainText("Your current answer: Not helpful yet");
  const exported = await page.request.get("/api/member/export");
  expect(exported.status()).toBe(200);
  const payload = await exported.json();
  expect(payload.records.lessonUsefulness).toMatchObject([
    { contentId: lessonId, contentVersion: 1, choice: "not_yet", revision: 2 },
  ]);
  // Submit the already rendered correction after deletion is committed.
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === COOKIE,
  )!;
  const ownerId = (
    await pool.query("SELECT id FROM principals WHERE token_hash=$1", [
      hash(cookie.value),
    ])
  ).rows[0].id;
  const beforeDeletion = (
    await pool.query("SELECT * FROM lesson_usefulness WHERE member_id=$1", [
      ownerId,
    ])
  ).rows;
  await activity.getByLabel("Your answer").selectOption("helpful");
  await activity
    .getByLabel("This is my own response about sample learning")
    .check();
  await pool.query(
    "UPDATE workspaces SET deleting_at=clock_timestamp() WHERE owner_principal_id=$1",
    [ownerId],
  );
  try {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/library/${lessonId}/usefulness`) &&
        response.request().method() === "POST",
    );
    await activity
      .getByRole("button", { name: "Correct my usefulness answer" })
      .click();
    expect((await response).status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "Usefulness response unavailable" }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      "Invented practical step",
    );
    await expect(page.locator("body")).not.toContainText("Your current answer");
    expect(
      (
        await pool.query("SELECT * FROM lesson_usefulness WHERE member_id=$1", [
          ownerId,
        ])
      ).rows,
    ).toEqual(beforeDeletion);
  } finally {
    await pool.query(
      "UPDATE workspaces SET deleting_at=NULL WHERE owner_principal_id=$1",
      [ownerId],
    );
  }
  await page.goto("/progress");
  await expect(actors.catalog.retire(actors.editor, lessonId)).resolves.toBe(
    true,
  );
  await page.reload();
  await expect(activity).toContainText("historical version cannot receive");
  await expect(
    activity.getByRole("button", { name: "Correct my usefulness answer" }),
  ).toHaveCount(0);
  const other = await browser.newContext({ baseURL: origin });
  try {
    const outsider = await other.newPage();
    await onboard(outsider);
    await outsider.goto("/progress");
    await expect(outsider.getByText("Your current answer")).toHaveCount(0);
    const outsiderExport = await outsider.request.get("/api/member/export");
    expect((await outsiderExport.json()).records.lessonUsefulness).toEqual([]);
    await outsider.goto("/learn");
    const csrf = await outsider
      .locator('input[name="csrf"]')
      .first()
      .inputValue();
    const forged = await outsider.request.post(
      `/library/${lessonId}/usefulness`,
      {
        headers: { Origin: origin },
        form: {
          csrf,
          content_version: "1",
          revision: "0",
          choice: "helpful",
          confirm: "yes",
          intent: "save",
        },
      },
    );
    expect(forged.status()).toBe(409);
  } finally {
    await other.close();
  }
  await activity.getByLabel("Withdraw this private answer").check();
  await activity
    .getByRole("button", { name: "Withdraw my usefulness answer" })
    .click();
  await expect(activity).not.toContainText("Your current answer");
  expect(
    (await (await page.request.get("/api/member/export")).json()).records
      .lessonUsefulness,
  ).toEqual([]);
});
