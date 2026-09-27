import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { authorizationStore } from "../../src/authorization.ts";
import { catalogStore, type DraftContent } from "../../src/catalog.ts";
import { testPool } from "../support/database.ts";

const pool = testPool();
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

test("[L65] a private plan recommends only a current eligible sample lesson", async ({
  page,
  browser,
}, info) => {
  const id = info.project.name === "desktop-chromium" ? "SYN-997" : "SYN-998";
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
    title: "Invented next reading",
    body: "A made-up situation to compare with a source before acting.",
    owner: "Synthetic editor",
    sources: "Original invented example",
    rights: "Owned local sample",
    goals: ["everyday"],
    backgrounds: ["explorer"],
    domains: [],
    prerequisites: "None",
    minimumExperience: "new",
    rubric: null,
    rubricVersion: null,
  };
  const publish = async (version: number, title: string) => {
    expect(
      await catalog.createDraft(editor, { ...draft, version, title }),
    ).toBe(true);
    expect(await catalog.submit(editor, id, version)).toBe(true);
    expect(await catalog.approve(reviewer, id, version, true)).toBe(true);
    expect(await catalog.publish(editor, id, version)).toBe(true);
  };
  await onboard(page);
  const suggestion = page.getByRole("region", {
    name: "Suggested next sample lesson",
  });
  await expect(suggestion).not.toContainText("Invented next reading");
  await publish(1, draft.title);
  await page.reload();
  await expect(suggestion).toContainText("Invented next reading · version 1");
  await suggestion
    .getByRole("link", { name: "Open current sample lesson" })
    .click();
  await expect(page.getByRole("heading", { name: draft.title })).toBeVisible();
  await page.getByRole("button", { name: "Start this lesson" }).click();
  await page.getByLabel("I have finished reading this sample lesson").check();
  await page
    .getByRole("button", { name: "Mark self-assessed complete" })
    .click();
  await page.goto("/learn");
  await expect(suggestion).not.toContainText("Invented next reading");

  const unrelated = await browser.newContext({
    baseURL: "http://127.0.0.1:4317",
  });
  try {
    const other = await unrelated.newPage();
    await onboard(other);
    await expect(
      other.getByRole("region", { name: "Suggested next sample lesson" }),
    ).toContainText("Invented next reading · version 1");
  } finally {
    await unrelated.close();
  }

  await page.getByLabel("What would you like to do?").selectOption("build");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await expect(suggestion).not.toContainText("Invented next reading");
  await page.goto("/progress");
  await expect(page.locator("main ol")).toContainText("version 1");
  await page.goto("/learn");
  await page.getByLabel("What would you like to do?").selectOption("everyday");
  await page.getByRole("button", { name: "Save my direction" }).click();
  await publish(2, "Invented next reading revised");
  await page.reload();
  await expect(suggestion).toContainText(
    "Invented next reading revised · version 2",
  );
  await page.goto("/progress");
  await expect(page.locator("main ol")).toContainText("version 1");
  await expect(page.locator("main ol")).toContainText(
    "Historical version unavailable",
  );
  expect(await catalog.retire(editor, id)).toBe(true);
  await page.goto("/learn");
  await expect(suggestion).not.toContainText("Invented next reading");
});
